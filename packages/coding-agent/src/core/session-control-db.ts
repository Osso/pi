import { join } from "node:path";
import { emptySessionHealth, type SessionCheckStatus, type SessionHealthRecord } from "./session-health.ts";
import { configureSharedSqliteDatabase, createSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

export interface IncomingControlMessage {
	id: number;
	content: string;
}

export type RuntimeMailboxMessageKind = "message" | "ask" | "reply" | "steer" | "supervisor_request" | "system";
export type RuntimeMailboxMessageStatus = "pending" | "claimed" | "delivered" | "failed";

export interface RuntimeMailboxAddress {
	sessionId: string;
	agentId: string | null;
}

export interface RuntimeMailboxMessage {
	id: number;
	recipient: RuntimeMailboxAddress;
	sender: RuntimeMailboxAddress;
	kind: RuntimeMailboxMessageKind;
	body: string;
	artifactIds?: string[];
	artifactRefs?: RuntimeMailboxArtifactReference[];
	storeRef?: RuntimeMailboxStoreRef;
	status: RuntimeMailboxMessageStatus;
	createdAt: string;
	updatedAt: string;
	claimedAt?: string;
	deliveredAt?: string;
	error?: string;
}

export interface RuntimeMailboxArtifactReference {
	id?: string;
	path?: string;
	label?: string;
}

export interface RuntimeMailboxStoreRef {
	sessionPath: string;
	messageId: string;
}

export interface SharedChannelMessage {
	id: number;
	sender: RuntimeMailboxAddress;
	body: string;
	createdAt: string;
}

export interface PostSharedChannelMessageInput {
	sender: RuntimeMailboxAddress;
	body: string;
}

export interface EnqueueRuntimeMailboxMessageInput {
	recipient: RuntimeMailboxAddress;
	sender: RuntimeMailboxAddress;
	kind: RuntimeMailboxMessageKind;
	/**
	 * Reference to the persisted store row that owns this message's content. Transport rows
	 * never copy bodies; reads resolve payloads from `multi_agent_mailbox_messages`.
	 */
	storeRef: RuntimeMailboxStoreRef;
}

export interface LastControlMessage {
	role: "assistant";
	content: string;
	updatedAt: string;
}

export interface NamedSession {
	sessionPath: string;
	name: string;
	updatedAt: string;
}

export interface SessionMetadata {
	sessionPath: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	goalJson?: string;
	isSubagent?: boolean;
	subagentName?: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	updatedAt: string;
}

export type WritableSessionMetadata = Omit<SessionMetadata, "updatedAt">;

type IncomingRow = {
	id: number;
	content: string;
};

type RuntimeMailboxRow = {
	id: number;
	recipient_session_id: string;
	recipient_agent_id: string | null;
	sender_session_id: string | null;
	sender_agent_id: string | null;
	kind: string;
	body: string;
	artifact_ids_json: string | null;
	artifact_refs_json: string | null;
	store_session_path: string | null;
	store_message_id: string | null;
	status: string;
	created_at: string;
	updated_at: string;
	claimed_at: string | null;
	delivered_at: string | null;
	error: string | null;
};

type PromptHistoryRow = {
	content: string;
};

type LastMessageRow = {
	role: string;
	content: string;
	updated_at: string;
};

type RuntimeMailboxListenerRow = {
	pid: number;
	updated_at: string;
};

type SessionHealthRow = {
	session_id: string;
	agent_generation: number;
	pid: number | null;
	last_active_at: string | null;
	last_checked_at: string | null;
	check_status: string;
	checked_generation: number | null;
	check_latency_ms: number | null;
	updated_at: string;
};

type SharedChannelMessageRow = {
	id: number;
	sender_session_id: string;
	sender_agent_id: string | null;
	body: string;
	created_at: string;
};

type SharedChannelCursorRow = {
	last_seen_id: number;
};

type IncomingStatusRow = {
	status: string;
};

type NamedSessionRow = {
	session_path: string;
	name: string;
	updated_at: string;
};

type SessionMetadataRow = {
	session_path: string;
	id: string;
	cwd: string;
	name: string | null;
	parent_session_path: string | null;
	goal_json: string | null;
	is_subagent: number;
	subagent_name: string | null;
	created_at: string;
	modified_at: string;
	message_count: number;
	first_message: string;
	all_messages_text: string;
	updated_at: string;
};

type SessionMetadataPreservedRow = {
	goal_json: string | null;
	is_subagent: number;
	subagent_name: string | null;
};

type TableInfoRow = {
	name: string;
};

type GoalRow = {
	goal_json: string | null;
};

export function getControlDbPath(agentDir: string): string {
	return join(agentDir, "control.sqlite");
}

export function enqueueIncomingMessage(controlDbPath: string, content: string): number {
	return withControlDb(controlDbPath, (db) => {
		const result = db
			.prepare(
				`
				INSERT INTO incoming_messages (content, status, created_at)
				VALUES (?, 'pending', ?)
				`,
			)
			.run(content, new Date().toISOString());
		return Number(result.lastInsertRowid);
	});
}

export function claimLatestIncomingMessage(controlDbPath: string): IncomingControlMessage | undefined {
	return withControlDb(controlDbPath, (db) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const row = db
				.prepare(
					`
					SELECT id, content
					FROM incoming_messages
					WHERE status = 'pending'
					ORDER BY id DESC
					LIMIT 1
					`,
				)
				.get() as IncomingRow | undefined;

			if (!row) {
				db.exec("COMMIT");
				return undefined;
			}

			const now = new Date().toISOString();
			db.prepare(
				`
				UPDATE incoming_messages
				SET status = 'superseded', completed_at = ?
				WHERE status = 'pending' AND id <> ?
				`,
			).run(now, row.id);
			db.prepare(
				`
				UPDATE incoming_messages
				SET status = 'claimed', claimed_at = ?
				WHERE id = ?
				`,
			).run(now, row.id);
			db.exec("COMMIT");
			return row;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

export function completeIncomingMessage(controlDbPath: string, id: number): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			UPDATE incoming_messages
			SET status = 'completed', completed_at = ?
			WHERE id = ?
			`,
		).run(new Date().toISOString(), id);
	});
}

export function failIncomingMessage(controlDbPath: string, id: number, errorMessage: string): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			UPDATE incoming_messages
			SET status = 'failed', error = ?, completed_at = ?
			WHERE id = ?
			`,
		).run(errorMessage, new Date().toISOString(), id);
	});
}

export function readIncomingMessageStatus(controlDbPath: string, id: number): string | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`
				SELECT status
				FROM incoming_messages
				WHERE id = ?
				`,
			)
			.get(id) as IncomingStatusRow | undefined;
		return row?.status;
	});
}

export function enqueueRuntimeMailboxMessage(controlDbPath: string, input: EnqueueRuntimeMailboxMessageInput): number {
	const result = withControlDb(controlDbPath, (db) => {
		// One transport row per store message: the store row is the single record, so a
		// second enqueue for the same reference is a re-send of the same message.
		const existing = db
			.prepare("SELECT id FROM runtime_mailbox_messages WHERE store_session_path = ? AND store_message_id = ?")
			.get(input.storeRef.sessionPath, input.storeRef.messageId) as { id: number } | undefined;
		if (existing) {
			return { id: existing.id, listener: undefined };
		}
		const now = new Date().toISOString();
		const result = db
			.prepare(
				`
				INSERT INTO runtime_mailbox_messages (
					recipient_session_id,
					recipient_agent_id,
					sender_session_id,
					sender_agent_id,
					kind,
					body,
					artifact_ids_json,
					artifact_refs_json,
					store_session_path,
					store_message_id,
					status,
					created_at,
					updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
				`,
			)
			.run(
				input.recipient.sessionId,
				input.recipient.agentId,
				input.sender.sessionId,
				input.sender.agentId,
				input.kind,
				"",
				null,
				null,
				input.storeRef.sessionPath,
				input.storeRef.messageId,
				now,
				now,
			);
		const listener = readRuntimeMailboxListenerRow(db, input.recipient);
		return { id: Number(result.lastInsertRowid), listener };
	});
	notifyRuntimeMailboxListener(result.listener);
	return result.id;
}

export interface RecoverStaleRuntimeMailboxClaimsOptions {
	nowIso?: string;
	staleAfterMs?: number;
}

const DEFAULT_RUNTIME_MAILBOX_CLAIM_STALE_AFTER_MS = 5 * 60 * 1000;

export function recoverStaleRuntimeMailboxClaims(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	options: RecoverStaleRuntimeMailboxClaimsOptions = {},
): number {
	const nowIso = options.nowIso ?? new Date().toISOString();
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_RUNTIME_MAILBOX_CLAIM_STALE_AFTER_MS;
	const cutoff = new Date(new Date(nowIso).getTime() - staleAfterMs).toISOString();
	return withControlDb(controlDbPath, (db) => {
		const result = db
			.prepare(
				`
				UPDATE runtime_mailbox_messages
				SET status = 'pending', claimed_at = NULL, updated_at = ?
				WHERE status = 'claimed'
					AND claimed_at <= ?
					AND recipient_session_id = ?
					AND ((? IS NULL AND recipient_agent_id IS NULL) OR recipient_agent_id = ?)
				`,
			)
			.run(nowIso, cutoff, recipient.sessionId, recipient.agentId, recipient.agentId);
		return Number(result.changes);
	});
}

export function claimRuntimeMailboxMessages(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	limit = 20,
): RuntimeMailboxMessage[] {
	return withControlDb(controlDbPath, (db) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const rows = db
				.prepare(
					`
					SELECT *
					FROM runtime_mailbox_messages
					WHERE status = 'pending'
						AND recipient_session_id = ?
						AND ((? IS NULL AND recipient_agent_id IS NULL) OR recipient_agent_id = ?)
					ORDER BY id ASC
					LIMIT ?
					`,
				)
				.all(recipient.sessionId, recipient.agentId, recipient.agentId, limit) as RuntimeMailboxRow[];

			if (rows.length === 0) {
				db.exec("COMMIT");
				return [];
			}

			const now = new Date().toISOString();
			for (const row of rows) {
				db.prepare(
					`
					UPDATE runtime_mailbox_messages
					SET status = 'claimed', claimed_at = ?, updated_at = ?
					WHERE id = ? AND status = 'pending'
					`,
				).run(now, now, row.id);
			}
			db.exec("COMMIT");
			return rows.map((row) =>
				runtimeMailboxMessageFromRow(db, { ...row, status: "claimed", claimed_at: now, updated_at: now }),
			);
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

export function consumeRuntimeMailboxMessageByStoreRef(
	controlDbPath: string,
	storeRef: RuntimeMailboxStoreRef,
): number {
	return withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		const result = db
			.prepare(
				`
				UPDATE runtime_mailbox_messages
				SET status = 'delivered', delivered_at = ?, updated_at = ?
				WHERE status IN ('pending', 'claimed')
					AND store_session_path = ?
					AND store_message_id = ?
				`,
			)
			.run(now, now, storeRef.sessionPath, storeRef.messageId);
		return Number(result.changes);
	});
}

export function registerRuntimeMailboxListener(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	pid: number,
): void {
	withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		db.prepare(
			`
			INSERT INTO runtime_mailbox_listeners (recipient_session_id, recipient_agent_id_key, pid, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(recipient_session_id, recipient_agent_id_key) DO UPDATE SET
				pid = excluded.pid,
				updated_at = excluded.updated_at
			`,
		).run(recipient.sessionId, runtimeMailboxAgentIdKey(recipient.agentId), pid, now);
		// Main-thread listener rows are the durable source for live session pids/generations.
		if (recipient.agentId === null) {
			upsertSessionHealthForListener(db, recipient.sessionId, pid, now);
		}
	});
}

function readRuntimeMailboxListenerRow(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
): RuntimeMailboxListenerRow | undefined {
	return db
		.prepare(
			`
			SELECT pid, updated_at
			FROM runtime_mailbox_listeners
			WHERE recipient_session_id = ? AND recipient_agent_id_key = ?
			`,
		)
		.get(recipient.sessionId, runtimeMailboxAgentIdKey(recipient.agentId)) as RuntimeMailboxListenerRow | undefined;
}

export function readRuntimeMailboxListener(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
): { pid: number; updatedAt: string } | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = readRuntimeMailboxListenerRow(db, recipient);
		if (!row) return undefined;
		return { pid: row.pid, updatedAt: row.updated_at };
	});
}

export function listRuntimeMailboxListeners(
	controlDbPath: string,
): Array<{ sessionId: string; agentId: string | null; pid: number; updatedAt: string }> {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`
				SELECT recipient_session_id, recipient_agent_id_key, pid, updated_at
				FROM runtime_mailbox_listeners
				`,
			)
			.all() as Array<{
			recipient_session_id: string;
			recipient_agent_id_key: string;
			pid: number;
			updated_at: string;
		}>;
		return rows.map((row) => ({
			sessionId: row.recipient_session_id,
			agentId: row.recipient_agent_id_key === "" ? null : row.recipient_agent_id_key,
			pid: row.pid,
			updatedAt: row.updated_at,
		}));
	});
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
				SELECT id, sender_session_id, sender_agent_id, body, created_at
				FROM shared_channel_messages
				WHERE id > ? AND id <= ?
				ORDER BY id ASC
				LIMIT ?
				`,
			)
			.all(lastSeenId, throughId, limit) as SharedChannelMessageRow[];
		return rows.map(sharedChannelMessageFromRow);
	});
}

export function readSharedChannelCursor(controlDbPath: string, recipient: RuntimeMailboxAddress): number | undefined {
	return withControlDb(controlDbPath, (db) => {
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
	});
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

function readSharedChannelCursorRow(db: SqliteDatabase, recipient: RuntimeMailboxAddress): number | undefined {
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

function readSharedChannelTailRow(db: SqliteDatabase): number {
	const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS tail FROM shared_channel_messages").get() as
		| { tail: number }
		| undefined;
	return row?.tail ?? 0;
}

function writeSharedChannelCursorRow(db: SqliteDatabase, recipient: RuntimeMailboxAddress, lastSeenId: number): void {
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

function sharedChannelMessageFromRow(row: SharedChannelMessageRow): SharedChannelMessage {
	return {
		body: row.body,
		createdAt: row.created_at,
		id: row.id,
		sender: { agentId: row.sender_agent_id, sessionId: row.sender_session_id },
	};
}

export function readSessionHealth(controlDbPath: string, sessionId: string): SessionHealthRecord | undefined {
	return withControlDb(controlDbPath, (db) => readSessionHealthRow(db, sessionId));
}

export function listSessionHealth(controlDbPath: string): SessionHealthRecord[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`
				SELECT
					session_id,
					agent_generation,
					pid,
					last_active_at,
					last_checked_at,
					check_status,
					checked_generation,
					check_latency_ms,
					updated_at
				FROM session_health
				ORDER BY updated_at DESC
				`,
			)
			.all() as SessionHealthRow[];
		return rows.map(sessionHealthFromRow);
	});
}

export function writeSessionHealth(controlDbPath: string, health: SessionHealthRecord): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			INSERT INTO session_health (
				session_id,
				agent_generation,
				pid,
				last_active_at,
				last_checked_at,
				check_status,
				checked_generation,
				check_latency_ms,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				agent_generation = excluded.agent_generation,
				pid = excluded.pid,
				last_active_at = excluded.last_active_at,
				last_checked_at = excluded.last_checked_at,
				check_status = excluded.check_status,
				checked_generation = excluded.checked_generation,
				check_latency_ms = excluded.check_latency_ms,
				updated_at = excluded.updated_at
			`,
		).run(
			health.sessionId,
			health.agentGeneration,
			health.pid,
			health.lastActiveAt,
			health.lastCheckedAt,
			health.checkStatus,
			health.checkedGeneration,
			health.checkLatencyMs,
			health.updatedAt,
		);
	});
}

function readSessionHealthRow(db: SqliteDatabase, sessionId: string): SessionHealthRecord | undefined {
	const row = db
		.prepare(
			`
			SELECT
				session_id,
				agent_generation,
				pid,
				last_active_at,
				last_checked_at,
				check_status,
				checked_generation,
				check_latency_ms,
				updated_at
			FROM session_health
			WHERE session_id = ?
			`,
		)
		.get(sessionId) as SessionHealthRow | undefined;
	return row ? sessionHealthFromRow(row) : undefined;
}

function upsertSessionHealthForListener(db: SqliteDatabase, sessionId: string, pid: number, nowIso: string): void {
	const existing = readSessionHealthRow(db, sessionId) ?? emptySessionHealth(sessionId, nowIso);
	const next =
		existing.pid === pid && existing.agentGeneration > 0
			? {
					...existing,
					pid,
					lastActiveAt: nowIso,
					updatedAt: nowIso,
				}
			: {
					...existing,
					pid,
					agentGeneration: existing.agentGeneration + 1,
					lastActiveAt: nowIso,
					updatedAt: nowIso,
				};
	db.prepare(
		`
		INSERT INTO session_health (
			session_id,
			agent_generation,
			pid,
			last_active_at,
			last_checked_at,
			check_status,
			checked_generation,
			check_latency_ms,
			updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			agent_generation = excluded.agent_generation,
			pid = excluded.pid,
			last_active_at = excluded.last_active_at,
			last_checked_at = excluded.last_checked_at,
			check_status = excluded.check_status,
			checked_generation = excluded.checked_generation,
			check_latency_ms = excluded.check_latency_ms,
			updated_at = excluded.updated_at
		`,
	).run(
		next.sessionId,
		next.agentGeneration,
		next.pid,
		next.lastActiveAt,
		next.lastCheckedAt,
		next.checkStatus,
		next.checkedGeneration,
		next.checkLatencyMs,
		next.updatedAt,
	);
}

function sessionHealthFromRow(row: SessionHealthRow): SessionHealthRecord {
	return {
		sessionId: row.session_id,
		agentGeneration: row.agent_generation,
		pid: row.pid,
		lastActiveAt: row.last_active_at,
		lastCheckedAt: row.last_checked_at,
		checkStatus: toSessionCheckStatus(row.check_status),
		checkedGeneration: row.checked_generation,
		checkLatencyMs: row.check_latency_ms,
		updatedAt: row.updated_at,
	};
}

function toSessionCheckStatus(value: string): SessionCheckStatus {
	if (value === "ok" || value === "dead" || value === "timeout" || value === "never") {
		return value;
	}
	return "never";
}

function runtimeMailboxAgentIdKey(agentId: string | null): string {
	return agentId ?? "";
}

function notifyRuntimeMailboxListener(listener: RuntimeMailboxListenerRow | undefined): void {
	if (!listener || process.platform === "win32") {
		return;
	}
	if (listener.pid === process.pid && process.listenerCount("SIGUSR2") === 0) {
		// Signalling ourselves with no wake handler installed would terminate the
		// process (OS default action). Polling delivers the message instead.
		return;
	}
	try {
		process.kill(listener.pid, "SIGUSR2");
	} catch {
		// Stale listener rows are harmless; polling and later registration will recover.
	}
}

export function markRuntimeMailboxMessageDelivered(controlDbPath: string, id: number): void {
	withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		db.prepare(
			`
			UPDATE runtime_mailbox_messages
			SET status = 'delivered', delivered_at = ?, updated_at = ?
			WHERE id = ?
			`,
		).run(now, now, id);
	});
}

export function releaseRuntimeMailboxMessageClaim(controlDbPath: string, id: number): void {
	withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		db.prepare(
			`
			UPDATE runtime_mailbox_messages
			SET status = 'pending', claimed_at = NULL, updated_at = ?
			WHERE id = ? AND status = 'claimed'
			`,
		).run(now, id);
	});
}

export function failRuntimeMailboxMessage(controlDbPath: string, id: number, errorMessage: string): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			UPDATE runtime_mailbox_messages
			SET status = 'failed', error = ?, updated_at = ?
			WHERE id = ?
			`,
		).run(errorMessage, new Date().toISOString(), id);
	});
}

export function readRuntimeMailboxMessage(controlDbPath: string, id: number): RuntimeMailboxMessage | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db.prepare("SELECT * FROM runtime_mailbox_messages WHERE id = ?").get(id) as
			| RuntimeMailboxRow
			| undefined;
		return row ? runtimeMailboxMessageFromRow(db, row) : undefined;
	});
}

export function listRuntimeMailboxMessages(controlDbPath: string): RuntimeMailboxMessage[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db.prepare("SELECT * FROM runtime_mailbox_messages ORDER BY id ASC").all() as RuntimeMailboxRow[];
		return rows.map((row) => runtimeMailboxMessageFromRow(db, row));
	});
}

export function cleanupRuntimeMailboxMessages(controlDbPath: string, nowIso = new Date().toISOString()): number {
	const cutoff = new Date(new Date(nowIso).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
	return withControlDb(controlDbPath, (db) => {
		const result = db.prepare("DELETE FROM runtime_mailbox_messages WHERE created_at < ?").run(cutoff);
		return result.changes;
	});
}

function runtimeMailboxMessageFromRow(db: SqliteDatabase, row: RuntimeMailboxRow): RuntimeMailboxMessage {
	const stored = readReferencedStoreMessage(db, row);
	return {
		id: row.id,
		recipient: { agentId: row.recipient_agent_id, sessionId: row.recipient_session_id },
		sender: { agentId: row.sender_agent_id, sessionId: row.sender_session_id ?? "" },
		kind: toRuntimeMailboxMessageKind(row.kind),
		body: stored?.body ?? row.body,
		artifactIds: stored ? stored.artifactIds : parseStringArray(row.artifact_ids_json),
		artifactRefs: stored ? stored.artifactRefs : parseArtifactReferences(row.artifact_refs_json),
		storeRef:
			row.store_session_path && row.store_message_id
				? { messageId: row.store_message_id, sessionPath: row.store_session_path }
				: undefined,
		status: toRuntimeMailboxMessageStatus(row.status),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		claimedAt: row.claimed_at ?? undefined,
		deliveredAt: row.delivered_at ?? undefined,
		error: row.error ?? undefined,
	};
}

function readReferencedStoreMessage(
	db: SqliteDatabase,
	row: RuntimeMailboxRow,
): { body: string; artifactIds?: string[]; artifactRefs?: RuntimeMailboxArtifactReference[] } | undefined {
	if (!row.store_session_path || !row.store_message_id) {
		return undefined;
	}
	const stored = db
		.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
		.get(row.store_session_path, row.store_message_id) as { data: string } | undefined;
	if (!stored) {
		return undefined;
	}
	try {
		const data = JSON.parse(stored.data) as {
			body?: string;
			artifactIds?: string[];
			artifactRefs?: RuntimeMailboxArtifactReference[];
		};
		return {
			body: data.body ?? "",
			artifactIds: Array.isArray(data.artifactIds) ? data.artifactIds : undefined,
			artifactRefs: Array.isArray(data.artifactRefs) ? data.artifactRefs : undefined,
		};
	} catch {
		return undefined;
	}
}

function toRuntimeMailboxMessageKind(value: string): RuntimeMailboxMessageKind {
	if (
		value === "message" ||
		value === "ask" ||
		value === "reply" ||
		value === "steer" ||
		value === "supervisor_request" ||
		value === "system"
	) {
		return value;
	}
	return "message";
}

function toRuntimeMailboxMessageStatus(value: string): RuntimeMailboxMessageStatus {
	if (value === "pending" || value === "claimed" || value === "delivered" || value === "failed") {
		return value;
	}
	return "failed";
}

function parseStringArray(value: string | null): string[] | undefined {
	const parsed = parseJsonArray(value);
	return parsed?.filter((item): item is string => typeof item === "string");
}

function parseArtifactReferences(value: string | null): RuntimeMailboxArtifactReference[] | undefined {
	const parsed = parseJsonArray(value);
	if (!parsed) {
		return undefined;
	}
	return parsed.flatMap((item): RuntimeMailboxArtifactReference[] => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			return [];
		}
		const ref = item as Record<string, unknown>;
		return [
			{
				id: typeof ref.id === "string" ? ref.id : undefined,
				label: typeof ref.label === "string" ? ref.label : undefined,
				path: typeof ref.path === "string" ? ref.path : undefined,
			},
		];
	});
}

function parseJsonArray(value: string | null): unknown[] | undefined {
	if (!value) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function writeLastMessage(controlDbPath: string, message: { role: "assistant"; content: string }): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			INSERT INTO last_message (id, role, content, updated_at)
			VALUES (1, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				role = excluded.role,
				content = excluded.content,
				updated_at = excluded.updated_at
			`,
		).run(message.role, message.content, new Date().toISOString());
	});
}

export function readLastMessage(controlDbPath: string): LastControlMessage | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`
				SELECT role, content, updated_at
				FROM last_message
				WHERE id = 1
				`,
			)
			.get() as LastMessageRow | undefined;

		if (!row) return undefined;
		if (row.role !== "assistant") return undefined;
		return {
			role: row.role,
			content: row.content,
			updatedAt: row.updated_at,
		};
	});
}

export function recordPromptHistoryEntry(controlDbPath: string, content: string): void {
	withControlDb(controlDbPath, (db) => {
		insertPromptHistoryEntry(db, content);
	});
}

export function readPromptHistory(controlDbPath: string, limit = 100): string[] {
	return withControlDb(controlDbPath, (db) => readPromptHistoryRows(db, limit));
}

export function readOrMigratePromptHistory(controlDbPath: string, legacyEntries: string[], limit = 100): string[] {
	return withControlDb(controlDbPath, (db) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const existingEntries = readPromptHistoryRows(db, limit);
			if (existingEntries.length > 0) {
				db.exec("COMMIT");
				return existingEntries;
			}

			for (const entry of [...legacyEntries].reverse()) {
				insertPromptHistoryEntry(db, entry);
			}
			db.exec("COMMIT");
			return legacyEntries.slice(0, limit);
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

function readPromptHistoryRows(db: SqliteDatabase, limit: number): string[] {
	const rows = db
		.prepare(
			`
			SELECT content
			FROM prompt_history
			ORDER BY id DESC
			LIMIT ?
			`,
		)
		.all(limit) as PromptHistoryRow[];
	return rows.map((row) => row.content);
}

function insertPromptHistoryEntry(db: SqliteDatabase, content: string): void {
	const trimmedContent = content.trim();
	if (!trimmedContent) return;
	if (readLatestPromptHistoryEntry(db) === trimmedContent) return;

	db.prepare(
		`
		INSERT INTO prompt_history (content, created_at)
		VALUES (?, ?)
		`,
	).run(trimmedContent, new Date().toISOString());
}

function readLatestPromptHistoryEntry(db: SqliteDatabase): string | undefined {
	const row = db
		.prepare(
			`
			SELECT content
			FROM prompt_history
			ORDER BY id DESC
			LIMIT 1
			`,
		)
		.get() as PromptHistoryRow | undefined;
	return row?.content;
}

export function setNamedSession(controlDbPath: string, sessionPath: string, name: string): void {
	const trimmedName = name.trim();
	if (!trimmedName) {
		removeNamedSession(controlDbPath, sessionPath);
		return;
	}

	withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		db.prepare(
			`
			INSERT INTO named_sessions (session_path, name, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(session_path) DO UPDATE SET
				name = excluded.name,
				updated_at = excluded.updated_at
			`,
		).run(sessionPath, trimmedName, now);
		db.prepare(
			`
			UPDATE session_metadata
			SET name = ?, updated_at = ?
			WHERE session_path = ?
			`,
		).run(trimmedName, now, sessionPath);
	});
}

export function removeNamedSession(controlDbPath: string, sessionPath: string): void {
	withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		db.prepare("DELETE FROM named_sessions WHERE session_path = ?").run(sessionPath);
		db.prepare(
			`
			UPDATE session_metadata
			SET name = NULL, updated_at = ?
			WHERE session_path = ?
			`,
		).run(now, sessionPath);
	});
}

export function listNamedSessions(controlDbPath: string): NamedSession[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`
				SELECT session_path, name, updated_at
				FROM named_sessions
				ORDER BY updated_at DESC
				`,
			)
			.all() as NamedSessionRow[];
		return rows.map((row) => ({
			sessionPath: row.session_path,
			name: row.name,
			updatedAt: row.updated_at,
		}));
	});
}

export function relocateSessionControlData(
	controlDbPath: string,
	oldSessionPath: string,
	newSessionPath: string,
): void {
	if (oldSessionPath === newSessionPath) {
		return;
	}

	withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		db.exec("BEGIN IMMEDIATE");
		try {
			relocateSessionPathPrimaryKey(db, "session_metadata", oldSessionPath, newSessionPath, now);
			relocateSessionPathPrimaryKey(db, "named_sessions", oldSessionPath, newSessionPath, now);
			relocateMultiAgentSessionRows(db, "multi_agent_agents", oldSessionPath, newSessionPath, now);
			relocateMultiAgentSessionRows(db, "multi_agent_artifacts", oldSessionPath, newSessionPath, now);
			relocateMultiAgentSessionRows(db, "multi_agent_mailbox_messages", oldSessionPath, newSessionPath, now);
			relocateSessionPathPrimaryKey(db, "multi_agent_counters", oldSessionPath, newSessionPath, now);
			db.prepare(
				`
				UPDATE runtime_mailbox_messages
				SET store_session_path = ?, updated_at = ?
				WHERE store_session_path = ?
				`,
			).run(newSessionPath, now, oldSessionPath);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

function relocateSessionPathPrimaryKey(
	db: SqliteDatabase,
	table: string,
	oldSessionPath: string,
	newSessionPath: string,
	now: string,
): void {
	db.prepare(`DELETE FROM ${table} WHERE session_path = ?`).run(newSessionPath);
	db.prepare(`UPDATE ${table} SET session_path = ?, updated_at = ? WHERE session_path = ?`).run(
		newSessionPath,
		now,
		oldSessionPath,
	);
}

function relocateMultiAgentSessionRows(
	db: SqliteDatabase,
	table: "multi_agent_agents" | "multi_agent_artifacts" | "multi_agent_mailbox_messages",
	oldSessionPath: string,
	newSessionPath: string,
	now: string,
): void {
	db.prepare(`DELETE FROM ${table} WHERE session_path = ?`).run(newSessionPath);
	db.prepare(`UPDATE ${table} SET session_path = ?, updated_at = ? WHERE session_path = ?`).run(
		newSessionPath,
		now,
		oldSessionPath,
	);
}

export function writeSessionMetadata(controlDbPath: string, metadata: WritableSessionMetadata): void {
	withControlDb(controlDbPath, (db) => {
		const metadataName = metadata.name ?? readNamedSessionName(db, metadata.sessionPath);
		const preserved = readPreservedSessionMetadata(db, metadata.sessionPath);
		const goalJson = metadata.goalJson ?? preserved?.goal_json ?? null;
		const preservedIsSubagent = preserved?.is_subagent === 1;
		const isSubagent = metadata.isSubagent ?? preservedIsSubagent;
		const subagentName = metadata.subagentName ?? preserved?.subagent_name ?? null;
		db.prepare(
			`
			INSERT INTO session_metadata (
				session_path,
				id,
				cwd,
				name,
				parent_session_path,
				goal_json,
				is_subagent,
				subagent_name,
				created_at,
				modified_at,
				message_count,
				first_message,
				all_messages_text,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_path) DO UPDATE SET
				id = excluded.id,
				cwd = excluded.cwd,
				name = excluded.name,
				parent_session_path = excluded.parent_session_path,
				goal_json = excluded.goal_json,
				is_subagent = excluded.is_subagent,
				subagent_name = excluded.subagent_name,
				created_at = excluded.created_at,
				modified_at = excluded.modified_at,
				message_count = excluded.message_count,
				first_message = excluded.first_message,
				all_messages_text = excluded.all_messages_text,
				updated_at = excluded.updated_at
			`,
		).run(
			metadata.sessionPath,
			metadata.id,
			metadata.cwd,
			metadataName,
			metadata.parentSessionPath ?? null,
			goalJson,
			isSubagent ? 1 : 0,
			subagentName,
			metadata.createdAt,
			metadata.modifiedAt,
			metadata.messageCount,
			metadata.firstMessage,
			metadata.allMessagesText,
			new Date().toISOString(),
		);
	});
}

function readPreservedSessionMetadata(
	db: SqliteDatabase,
	sessionPath: string,
): SessionMetadataPreservedRow | undefined {
	return db
		.prepare(
			`
			SELECT goal_json, is_subagent, subagent_name
			FROM session_metadata
			WHERE session_path = ?
			`,
		)
		.get(sessionPath) as SessionMetadataPreservedRow | undefined;
}

export function writeSessionGoal(controlDbPath: string, sessionPath: string, goalJson: string | undefined): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			UPDATE session_metadata
			SET goal_json = ?, updated_at = ?
			WHERE session_path = ?
			`,
		).run(goalJson ?? null, new Date().toISOString(), sessionPath);
	});
}

export function readSessionGoal(controlDbPath: string, sessionPath: string): string | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`
				SELECT goal_json
				FROM session_metadata
				WHERE session_path = ?
				`,
			)
			.get(sessionPath) as GoalRow | undefined;
		return row?.goal_json ?? undefined;
	});
}

function readNamedSessionName(db: SqliteDatabase, sessionPath: string): string | null {
	const row = db.prepare("SELECT name FROM named_sessions WHERE session_path = ?").get(sessionPath) as
		| { name: string }
		| undefined;
	return row?.name ?? null;
}

export function readSessionMetadata(controlDbPath: string, sessionPath: string): SessionMetadata | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`
				SELECT
					session_path,
					id,
					cwd,
					name,
					parent_session_path,
					goal_json,
					is_subagent,
					subagent_name,
					created_at,
					modified_at,
					message_count,
					first_message,
					all_messages_text,
					updated_at
				FROM session_metadata
				WHERE session_path = ?
				`,
			)
			.get(sessionPath) as SessionMetadataRow | undefined;
		return row ? sessionMetadataFromRow(row) : undefined;
	});
}

export function listSessionMetadata(controlDbPath: string): SessionMetadata[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`
				SELECT
					session_path,
					id,
					cwd,
					name,
					parent_session_path,
					goal_json,
					is_subagent,
					subagent_name,
					created_at,
					modified_at,
					message_count,
					first_message,
					all_messages_text,
					updated_at
				FROM session_metadata
				ORDER BY modified_at DESC, updated_at DESC
				`,
			)
			.all() as SessionMetadataRow[];
		return rows.map(sessionMetadataFromRow);
	});
}

function sessionMetadataFromRow(row: SessionMetadataRow): SessionMetadata {
	return {
		sessionPath: row.session_path,
		id: row.id,
		cwd: row.cwd,
		name: row.name ?? undefined,
		parentSessionPath: row.parent_session_path ?? undefined,
		goalJson: row.goal_json ?? undefined,
		isSubagent: row.is_subagent === 1,
		subagentName: row.subagent_name ?? undefined,
		createdAt: row.created_at,
		modifiedAt: row.modified_at,
		messageCount: row.message_count,
		firstMessage: row.first_message,
		allMessagesText: row.all_messages_text,
		updatedAt: row.updated_at,
	};
}

export interface MultiAgentCounters {
	nextAgentNumber: number;
	nextArtifactNumber: number;
	nextMessageNumber: number;
}

export interface MultiAgentPersistedState {
	agents: unknown[];
	artifacts: unknown[];
	mailboxMessages: unknown[];
	counters: MultiAgentCounters;
}

function upsertMultiAgentRow(
	controlDbPath: string,
	table: "multi_agent_agents" | "multi_agent_artifacts" | "multi_agent_mailbox_messages",
	idColumn: "agent_id" | "artifact_id" | "message_id",
	sessionPath: string,
	id: string,
	data: unknown,
): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			INSERT INTO ${table} (session_path, ${idColumn}, data, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(session_path, ${idColumn}) DO UPDATE SET
				data = excluded.data,
				updated_at = excluded.updated_at
			`,
		).run(sessionPath, id, JSON.stringify(data), new Date().toISOString());
	});
}

export function upsertMultiAgentAgent(controlDbPath: string, sessionPath: string, id: string, data: unknown): void {
	upsertMultiAgentRow(controlDbPath, "multi_agent_agents", "agent_id", sessionPath, id, data);
}

export function upsertMultiAgentArtifact(controlDbPath: string, sessionPath: string, id: string, data: unknown): void {
	upsertMultiAgentRow(controlDbPath, "multi_agent_artifacts", "artifact_id", sessionPath, id, data);
}

export function upsertMultiAgentMailboxMessage(
	controlDbPath: string,
	sessionPath: string,
	id: string,
	data: unknown,
): void {
	upsertMultiAgentRow(controlDbPath, "multi_agent_mailbox_messages", "message_id", sessionPath, id, data);
}

export function getMultiAgentMailboxMessageStatus(
	controlDbPath: string,
	sessionPath: string,
	messageId: string,
): string | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
			.get(sessionPath, messageId) as { data: string } | undefined;
		if (!row) {
			return undefined;
		}

		const parsed = parseJsonObject(row.data);
		return typeof parsed?.status === "string" ? parsed.status : undefined;
	});
}

export function markMultiAgentMailboxMessageDelivered(
	controlDbPath: string,
	sessionPath: string,
	messageId: string,
): boolean {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
			.get(sessionPath, messageId) as { data: string } | undefined;
		if (!row) {
			return false;
		}

		const parsed = parseJsonObject(row.data);
		if (!parsed || parsed.status !== "pending") {
			return false;
		}

		const now = new Date().toISOString();
		const updated = { ...parsed, status: "delivered", updatedAt: now };
		db.prepare(
			`
			UPDATE multi_agent_mailbox_messages
			SET data = ?, updated_at = ?
			WHERE session_path = ? AND message_id = ?
			`,
		).run(JSON.stringify(updated), now, sessionPath, messageId);
		return true;
	});
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function writeMultiAgentCounters(
	controlDbPath: string,
	sessionPath: string,
	counters: MultiAgentCounters,
): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			INSERT INTO multi_agent_counters (
				session_path, next_agent_number, next_artifact_number, next_message_number, updated_at
			)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(session_path) DO UPDATE SET
				next_agent_number = excluded.next_agent_number,
				next_artifact_number = excluded.next_artifact_number,
				next_message_number = excluded.next_message_number,
				updated_at = excluded.updated_at
			`,
		).run(
			sessionPath,
			counters.nextAgentNumber,
			counters.nextArtifactNumber,
			counters.nextMessageNumber,
			new Date().toISOString(),
		);
	});
}

export type MultiAgentCounterName = "agent" | "artifact" | "message";

type MultiAgentCounterRow = {
	next_agent_number: number;
	next_artifact_number: number;
	next_message_number: number;
};

const MULTI_AGENT_COUNTER_COLUMNS: Record<MultiAgentCounterName, keyof MultiAgentCounterRow> = {
	agent: "next_agent_number",
	artifact: "next_artifact_number",
	message: "next_message_number",
};

export function allocateMultiAgentCounter(
	controlDbPath: string,
	sessionPath: string,
	counterName: MultiAgentCounterName,
): number {
	const column = MULTI_AGENT_COUNTER_COLUMNS[counterName];
	return withControlDb(controlDbPath, (db) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const now = new Date().toISOString();
			const row = db
				.prepare(
					`
					SELECT next_agent_number, next_artifact_number, next_message_number
					FROM multi_agent_counters WHERE session_path = ?
					`,
				)
				.get(sessionPath) as MultiAgentCounterRow | undefined;
			const counters = {
				next_agent_number: row?.next_agent_number ?? 1,
				next_artifact_number: row?.next_artifact_number ?? 1,
				next_message_number: row?.next_message_number ?? 1,
			};
			const allocated = counters[column];
			counters[column] = allocated + 1;
			db.prepare(
				`
				INSERT INTO multi_agent_counters (
					session_path, next_agent_number, next_artifact_number, next_message_number, updated_at
				)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(session_path) DO UPDATE SET
					next_agent_number = excluded.next_agent_number,
					next_artifact_number = excluded.next_artifact_number,
					next_message_number = excluded.next_message_number,
					updated_at = excluded.updated_at
				`,
			).run(
				sessionPath,
				counters.next_agent_number,
				counters.next_artifact_number,
				counters.next_message_number,
				now,
			);
			db.exec("COMMIT");
			return allocated;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

export function readMultiAgentState(controlDbPath: string, sessionPath: string): MultiAgentPersistedState | undefined {
	return withControlDb(controlDbPath, (db) => {
		const readRows = (table: string): unknown[] =>
			(
				db.prepare(`SELECT data FROM ${table} WHERE session_path = ? ORDER BY rowid`).all(sessionPath) as Array<{
					data: string;
				}>
			)
				.map((row) => {
					try {
						return JSON.parse(row.data) as unknown;
					} catch {
						return undefined;
					}
				})
				.filter((data) => data !== undefined);
		const counters = db
			.prepare(
				`
				SELECT next_agent_number, next_artifact_number, next_message_number
				FROM multi_agent_counters WHERE session_path = ?
				`,
			)
			.get(sessionPath) as
			| { next_agent_number: number; next_artifact_number: number; next_message_number: number }
			| undefined;
		const agents = readRows("multi_agent_agents");
		if (!counters && agents.length === 0) {
			return undefined;
		}
		return {
			agents,
			artifacts: readRows("multi_agent_artifacts"),
			mailboxMessages: readRows("multi_agent_mailbox_messages"),
			counters: {
				nextAgentNumber: counters?.next_agent_number ?? 1,
				nextArtifactNumber: counters?.next_artifact_number ?? 1,
				nextMessageNumber: counters?.next_message_number ?? 1,
			},
		};
	});
}

function withControlDb<T>(controlDbPath: string, callback: (db: SqliteDatabase) => T): T {
	const db = createSqliteDatabase(controlDbPath);
	try {
		// Shared control.sqlite is multi-process (all Pi sessions on the machine).
		// WAL + busy_timeout keeps list_sessions/broadcast and mailbox writes safe under contention.
		configureSharedSqliteDatabase(db);
		initializeSchema(db);
		return callback(db);
	} finally {
		db.close();
	}
}

function initializeSchema(db: SqliteDatabase): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS incoming_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			content TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			claimed_at TEXT,
			completed_at TEXT,
			error TEXT
		);

		CREATE TABLE IF NOT EXISTS last_message (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS runtime_mailbox_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			recipient_session_id TEXT NOT NULL,
			recipient_agent_id TEXT,
			sender_session_id TEXT,
			sender_agent_id TEXT,
			kind TEXT NOT NULL,
			body TEXT NOT NULL,
			artifact_ids_json TEXT,
			artifact_refs_json TEXT,
			store_session_path TEXT,
			store_message_id TEXT,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			claimed_at TEXT,
			delivered_at TEXT,
			error TEXT
		);

		CREATE INDEX IF NOT EXISTS runtime_mailbox_recipient_status_idx
		ON runtime_mailbox_messages(recipient_session_id, recipient_agent_id, status, id);

		CREATE INDEX IF NOT EXISTS runtime_mailbox_created_at_idx
		ON runtime_mailbox_messages(created_at);

		CREATE TABLE IF NOT EXISTS runtime_mailbox_listeners (
			recipient_session_id TEXT NOT NULL,
			recipient_agent_id_key TEXT NOT NULL,
			pid INTEGER NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (recipient_session_id, recipient_agent_id_key)
		);

		CREATE TABLE IF NOT EXISTS named_sessions (
			session_path TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS prompt_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS prompt_history_id_idx
		ON prompt_history(id DESC);

		CREATE TABLE IF NOT EXISTS session_metadata (
			session_path TEXT PRIMARY KEY,
			id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			name TEXT,
			parent_session_path TEXT,
			goal_json TEXT,
			is_subagent INTEGER NOT NULL DEFAULT 0,
			subagent_name TEXT,
			created_at TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			message_count INTEGER NOT NULL,
			first_message TEXT NOT NULL,
			all_messages_text TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS session_metadata_modified_at_idx
		ON session_metadata(modified_at DESC, updated_at DESC);

		CREATE TABLE IF NOT EXISTS multi_agent_agents (
			session_path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			data TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_path, agent_id)
		);

		CREATE TABLE IF NOT EXISTS multi_agent_artifacts (
			session_path TEXT NOT NULL,
			artifact_id TEXT NOT NULL,
			data TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_path, artifact_id)
		);

		CREATE TABLE IF NOT EXISTS multi_agent_mailbox_messages (
			session_path TEXT NOT NULL,
			message_id TEXT NOT NULL,
			data TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_path, message_id)
		);

		CREATE TABLE IF NOT EXISTS multi_agent_counters (
			session_path TEXT PRIMARY KEY,
			next_agent_number INTEGER NOT NULL,
			next_artifact_number INTEGER NOT NULL,
			next_message_number INTEGER NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS session_health (
			session_id TEXT PRIMARY KEY,
			agent_generation INTEGER NOT NULL,
			pid INTEGER,
			last_active_at TEXT,
			last_checked_at TEXT,
			check_status TEXT NOT NULL,
			checked_generation INTEGER,
			check_latency_ms INTEGER,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS shared_channel_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sender_session_id TEXT NOT NULL,
			sender_agent_id TEXT,
			body TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS shared_channel_messages_id_idx
		ON shared_channel_messages(id);

		CREATE TABLE IF NOT EXISTS shared_channel_cursors (
			session_id TEXT NOT NULL,
			agent_id_key TEXT NOT NULL,
			last_seen_id INTEGER NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_id, agent_id_key)
		);
	`);
	addMissingSessionMetadataColumns(db);
	addMissingRuntimeMailboxColumns(db);
}

function addMissingRuntimeMailboxColumns(db: SqliteDatabase): void {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(runtime_mailbox_messages)").all() as TableInfoRow[]).map((column) => column.name),
	);
	if (!columns.has("store_session_path")) {
		db.exec("ALTER TABLE runtime_mailbox_messages ADD COLUMN store_session_path TEXT");
	}
	if (!columns.has("store_message_id")) {
		db.exec("ALTER TABLE runtime_mailbox_messages ADD COLUMN store_message_id TEXT");
	}
}

function addMissingSessionMetadataColumns(db: SqliteDatabase): void {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(session_metadata)").all() as TableInfoRow[]).map((column) => column.name),
	);
	if (!columns.has("goal_json")) {
		db.exec("ALTER TABLE session_metadata ADD COLUMN goal_json TEXT");
	}
	if (!columns.has("is_subagent")) {
		db.exec("ALTER TABLE session_metadata ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0");
	}
	if (!columns.has("subagent_name")) {
		db.exec("ALTER TABLE session_metadata ADD COLUMN subagent_name TEXT");
	}
}
