import { hostname } from "node:os";
import { MAILBOX_MESSAGE_RETENTION_MS } from "../mailbox-retention.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import {
	nullableStringField,
	optionalStringField,
	parseFileRefs,
	parseSteeringCheckpoint,
	requireStringField,
	toRuntimeMailboxMessageKind,
	toRuntimeMailboxMessageStatus,
} from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import { withImmediateTransaction } from "./helpers.ts";
import {
	compareAndDeleteCanonicalMailboxPayload,
	compareAndWriteSerializedCanonicalMailboxPayload,
	parseCanonicalMailboxPayload,
	RUNTIME_PROCESS_INSTANCE_ID,
} from "./runtime-mailbox-enqueue.ts";
import { MAILBOX_CREATED_AT_MS_SQL, type RuntimeMailboxMessage, type RuntimeMailboxRow } from "./types.ts";

export function readCanonicalMailboxRowById(db: SqliteDatabase, id: number): RuntimeMailboxRow | undefined {
	return db
		.prepare(
			`SELECT rowid AS id, session_path, message_id, data, updated_at
			 FROM multi_agent_mailbox_messages WHERE rowid = ? AND ${MAILBOX_CREATED_AT_MS_SQL} > ?`,
		)
		.get(id, Date.now() - MAILBOX_MESSAGE_RETENTION_MS) as RuntimeMailboxRow | undefined;
}

export function updateClaimedCanonicalMailboxMessage(
	controlDbPath: string,
	id: number,
	expectedPayloadData: string | undefined,
	status: "failed" | "pending",
	error?: string,
): boolean {
	return withControlDb(controlDbPath, (db) =>
		updateClaimedCanonicalMailboxMessageRow(db, id, expectedPayloadData, status, error),
	);
}

export function updateClaimedCanonicalMailboxMessageRow(
	db: SqliteDatabase,
	id: number,
	expectedPayloadData: string | undefined,
	status: "failed" | "pending",
	error: string | undefined,
): boolean {
	const row = readCanonicalMailboxRowById(db, id);
	if (!row) return false;
	const message = parseCanonicalMailboxPayload(row);
	if (message.status === status) return true;
	if (message.status !== "claimed" || message.claimantProcessIdentity !== RUNTIME_PROCESS_INSTANCE_ID) return false;
	if (expectedPayloadData !== undefined && row.data !== expectedPayloadData) return false;
	const now = new Date().toISOString();
	const updated: Record<string, unknown> = { ...message, status, updatedAt: now };
	delete updated.claimedAt;
	delete updated.claimantProcessIdentity;
	if (status === "failed") updated.error = error;
	const serialized = JSON.stringify(updated);
	return withImmediateTransaction(db, () =>
		compareAndWriteSerializedCanonicalMailboxPayload(db, row, serialized, now),
	);
}

export function markRuntimeMailboxMessageDelivered(controlDbPath: string, id: number): void {
	withControlDb(controlDbPath, (db) => {
		const row = readCanonicalMailboxRowById(db, id);
		if (!row) return;
		const host = parseCanonicalMailboxPayload(row).recipientHost;
		if (host && host !== hostname()) return;
		withImmediateTransaction(db, () => compareAndDeleteCanonicalMailboxPayload(db, row));
	});
}

export function releaseRuntimeMailboxMessageClaim(controlDbPath: string, id: number): void {
	updateClaimedCanonicalMailboxMessage(controlDbPath, id, undefined, "pending");
}

export function failRuntimeMailboxMessage(controlDbPath: string, id: number, errorMessage: string): void {
	updateClaimedCanonicalMailboxMessage(controlDbPath, id, undefined, "failed", errorMessage);
}

export function readRuntimeMailboxMessage(controlDbPath: string, id: number): RuntimeMailboxMessage | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = readCanonicalMailboxRowById(db, id);
		if (!row) return undefined;
		return runtimeMailboxMessageFromCanonicalRow(row, parseCanonicalMailboxPayload(row));
	});
}

export function listRuntimeMailboxMessages(controlDbPath: string): RuntimeMailboxMessage[] {
	return listRuntimeMailboxMessagesBySessionPath(controlDbPath);
}

/** Lists addressed canonical mailbox messages owned by this exact session path, for all recipients and statuses. */

export function listRuntimeMailboxMessagesForSession(
	controlDbPath: string,
	sessionPath: string,
): RuntimeMailboxMessage[] {
	return listRuntimeMailboxMessagesBySessionPath(controlDbPath, sessionPath);
}

export function listRuntimeMailboxMessagesBySessionPath(
	controlDbPath: string,
	sessionPath?: string,
): RuntimeMailboxMessage[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`SELECT rowid AS id, session_path, message_id, data, updated_at
				 FROM multi_agent_mailbox_messages
				 WHERE ${sessionPath === undefined ? "" : "session_path = ? AND "}json_valid(data)
				   AND json_type(data, '$.recipientSessionId') = 'text'
				   AND ${MAILBOX_CREATED_AT_MS_SQL} > ?
				 ORDER BY rowid ASC`,
			)
			.all(
				...(sessionPath === undefined ? [] : [sessionPath]),
				Date.now() - MAILBOX_MESSAGE_RETENTION_MS,
			) as RuntimeMailboxRow[];
		return rows.map((row) => runtimeMailboxMessageFromCanonicalRow(row, parseCanonicalMailboxPayload(row)));
	});
}

export function runtimeMailboxMessageFromCanonicalRow(
	row: RuntimeMailboxRow,
	message: Record<string, unknown>,
): RuntimeMailboxMessage {
	const context = `multi_agent_mailbox_messages:${row.session_path}#${row.message_id}`;
	return {
		id: row.id,
		recipient: {
			agentId: nullableStringField(message, "recipientAgentId", context),
			sessionId: requireStringField(message, "recipientSessionId", context),
		},
		sender: {
			agentId: nullableStringField(message, "senderAgentId", context),
			sessionId: requireStringField(message, "senderSessionId", context),
		},
		senderHost: optionalStringField(message, "senderHost", context),
		kind: toRuntimeMailboxMessageKind(requireStringField(message, "kind", context)),
		body: requireStringField(message, "body", context),
		fileRefs: parseFileRefs(message.fileRefs, context),
		targetCheckpoint: parseSteeringCheckpoint(message.targetCheckpoint, context),
		storeRef: { messageId: row.message_id, sessionPath: row.session_path },
		status: toRuntimeMailboxMessageStatus(requireStringField(message, "status", context)),
		createdAt: requireStringField(message, "createdAt", context),
		updatedAt: typeof message.updatedAt === "string" ? message.updatedAt : row.updated_at,
		claimedAt: optionalStringField(message, "claimedAt", context),
		error: optionalStringField(message, "error", context),
	};
}
