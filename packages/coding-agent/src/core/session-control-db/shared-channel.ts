import { hostname } from "node:os";
import { MAILBOX_MESSAGE_RETENTION_MS } from "../mailbox-retention.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { parseJsonObject } from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import {
	MAILBOX_CREATED_AT_MS_SQL,
	type PostSharedChannelMessageInput,
	type RuntimeMailboxAddress,
	type RuntimeMailboxMessage,
	type RuntimeMailboxMessageStatus,
	type RuntimeMailboxRow,
	type SharedChannelMessage,
} from "./types.ts";

export type SharedChannelMessageRow = {
	origin_host: string | null;
	origin_id: number | null;
	id: number;
	sender_session_id: string;
	sender_agent_id: string | null;
	body: string;
	created_at: string;
};

export type SharedChannelCursorRow = {
	last_seen_id: number;
};

export function readCanonicalMailboxRowsForRecipient(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	status: RuntimeMailboxMessageStatus,
	limit: number,
): RuntimeMailboxRow[] {
	return db
		.prepare(
			`SELECT rowid AS id, session_path, message_id, data, updated_at
			 FROM multi_agent_mailbox_messages
			 WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.status') END = ?
			   AND CASE WHEN json_valid(data) THEN json_extract(data, '$.recipientSessionId') END = ?
			   AND (json_extract(data, '$.recipientHost') IS NULL OR json_extract(data, '$.recipientHost') = ?)
			   AND ((? IS NULL AND CASE WHEN json_valid(data) THEN json_extract(data, '$.recipientAgentId') END IS NULL)
			        OR CASE WHEN json_valid(data) THEN json_extract(data, '$.recipientAgentId') END = ?)
			 AND ${MAILBOX_CREATED_AT_MS_SQL} > ?
			 ORDER BY rowid ASC
			 LIMIT ?`,
		)
		.all(
			status,
			recipient.sessionId,
			hostname(),
			recipient.agentId,
			recipient.agentId,
			Date.now() - MAILBOX_MESSAGE_RETENTION_MS,
			limit,
		) as RuntimeMailboxRow[];
}

export function postSharedChannelMessage(controlDbPath: string, input: PostSharedChannelMessageInput): number {
	const body = input.body.trim();
	if (!body) {
		throw new Error("shared channel message body must be non-empty");
	}
	return withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		const result = db
			.prepare(
				`
				INSERT INTO shared_channel_messages (sender_session_id, sender_agent_id, body, created_at)
				VALUES (?, ?, ?, ?)
				`,
			)
			.run(input.sender.sessionId, input.sender.agentId, body, now);
		return Number(result.lastInsertRowid);
	});
}

/** Messages at or before this `created_at` are expired even before the periodic cleanup deletes them. */
function sharedChannelCutoff(): string {
	return new Date(Date.now() - MAILBOX_MESSAGE_RETENTION_MS).toISOString();
}

export function listSharedChannelMessagesAfter(
	controlDbPath: string,
	lastSeenId: number,
	limit = 20,
	throughId = Number.MAX_SAFE_INTEGER,
): SharedChannelMessage[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`
				SELECT id, sender_session_id, sender_agent_id, body, created_at, origin_host, origin_id
				FROM shared_channel_messages
				WHERE id > ? AND id <= ? AND created_at > ?
				ORDER BY id ASC
				LIMIT ?
				`,
			)
			.all(lastSeenId, throughId, sharedChannelCutoff(), limit) as SharedChannelMessageRow[];
		return rows.map(sharedChannelMessageFromRow);
	});
}

export function readSharedChannelCursor(controlDbPath: string, recipient: RuntimeMailboxAddress): number | undefined {
	return withControlDb(controlDbPath, (db) => readSharedChannelCursorRow(db, recipient));
}

export function hasPendingRuntimeCoordinationMessage(controlDbPath: string, recipient: RuntimeMailboxAddress): boolean {
	return withControlDb(controlDbPath, (db) => {
		if (hasDeliverableRuntimeMailboxMessage(db, recipient)) {
			return true;
		}
		if (recipient.agentId !== null) {
			return false;
		}
		const cursor = readSharedChannelCursorRow(db, recipient);
		if (cursor === undefined) {
			return false;
		}
		const row = db
			.prepare(
				`
				SELECT 1 AS present
				FROM shared_channel_messages
				WHERE id > ?
					AND created_at > ?
					AND sender_agent_id IS NULL
					AND (origin_host IS NOT NULL OR sender_session_id <> ?)
				LIMIT 1
				`,
			)
			.get(cursor, sharedChannelCutoff(), recipient.sessionId) as { present: number } | undefined;
		return row != null;
	});
}

export function hasDeliverableRuntimeMailboxMessage(db: SqliteDatabase, recipient: RuntimeMailboxAddress): boolean {
	const rows = readCanonicalMailboxRowsForRecipient(db, recipient, "pending", Number.MAX_SAFE_INTEGER);
	return rows.some((row) => {
		const message = parseJsonObject(row.data);
		return message !== undefined && !isLifecycleNotificationPayload(message);
	});
}

export function isRuntimeCoordinationMailboxMessage(message: RuntimeMailboxMessage): boolean {
	return !isLifecycleNotificationPayload({
		body: message.body,
		id: message.storeRef.messageId,
		kind: message.kind,
		threadId: message.threadId,
	});
}

export function isLifecycleNotificationPayload(message: Record<string, unknown>): boolean {
	if (message.kind !== "system") return false;
	if (typeof message.id === "string" && message.id.startsWith("terminal:")) return true;
	const body = typeof message.body === "string" ? parseJsonObject(message.body) : undefined;
	if (body?.type === "multi_agent_terminal") return true;
	const threadId = message.threadId;
	return (
		typeof threadId === "string" &&
		["agent-completed:", "agent-failed:", "agent-waiting-for-input:"].some((prefix) => threadId.startsWith(prefix))
	);
}

export function initializeSharedChannelCursorAtTail(controlDbPath: string, recipient: RuntimeMailboxAddress): number {
	return withControlDb(controlDbPath, (db) => {
		const existing = readSharedChannelCursorRow(db, recipient);
		if (existing !== undefined) {
			return existing;
		}
		const tail = readSharedChannelTailRow(db);
		writeSharedChannelCursorRow(db, recipient, tail);
		return tail;
	});
}

export function advanceSharedChannelCursor(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	lastSeenId: number,
): void {
	withControlDb(controlDbPath, (db) => {
		writeSharedChannelCursorRow(db, recipient, lastSeenId);
	});
}

export function readSharedChannelCursorRow(db: SqliteDatabase, recipient: RuntimeMailboxAddress): number | undefined {
	const row = db
		.prepare(
			`
			SELECT last_seen_id
			FROM shared_channel_cursors
			WHERE session_id = ? AND agent_id_key = ?
			`,
		)
		.get(recipient.sessionId, runtimeMailboxAgentIdKey(recipient.agentId)) as SharedChannelCursorRow | undefined;
	return row?.last_seen_id;
}

export function readSharedChannelTail(controlDbPath: string): number {
	return withControlDb(controlDbPath, (db) => readSharedChannelTailRow(db));
}

export function readSharedChannelTailRow(db: SqliteDatabase): number {
	const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS tail FROM shared_channel_messages").get() as
		| { tail: number }
		| undefined;
	return row?.tail ?? 0;
}

export function writeSharedChannelCursorRow(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	lastSeenId: number,
): void {
	const now = new Date().toISOString();
	db.prepare(
		`
		INSERT INTO shared_channel_cursors (session_id, agent_id_key, last_seen_id, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(session_id, agent_id_key) DO UPDATE SET
			last_seen_id = MAX(shared_channel_cursors.last_seen_id, excluded.last_seen_id),
			updated_at = excluded.updated_at
		`,
	).run(recipient.sessionId, runtimeMailboxAgentIdKey(recipient.agentId), lastSeenId, now);
}

export function sharedChannelMessageFromRow(row: SharedChannelMessageRow): SharedChannelMessage {
	return {
		...(row.origin_host ? { originHost: row.origin_host, originId: row.origin_id ?? undefined } : {}),
		body: row.body,
		createdAt: row.created_at,
		id: row.id,
		sender: { agentId: row.sender_agent_id, sessionId: row.sender_session_id },
	};
}

export function runtimeMailboxAgentIdKey(agentId: string | null): string {
	return agentId ?? "";
}
