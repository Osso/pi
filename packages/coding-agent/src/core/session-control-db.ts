import { isAbsolute, join } from "node:path";
import type { DetachedJobTerminalInput } from "./detached-job-runner.ts";
import type { AgentFileReference, AgentMailboxMessage, AgentSnapshot } from "./multi-agent-store.ts";
import {
	isPiRuntimeProcessAlive,
	isProcessIdentityAlive,
	isVerifiedPiRuntimeProcess,
	type ProcessIdentity,
	readProcessIdentity,
} from "./runtime-process.ts";
import {
	emptySessionHealth,
	endSessionHealth,
	type SessionCheckStatus,
	type SessionHealthRecord,
} from "./session-health.ts";
import { configureSharedSqliteDatabase, createSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

const CONTROL_DB_SCHEMA_VERSION = 13;

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
	fileRefs?: AgentFileReference[];
	targetCheckpoint?: "next_model_call" | "after_tool_result" | "when_waiting";
	storeRef: RuntimeMailboxStoreRef;
	status: RuntimeMailboxMessageStatus;
	createdAt: string;
	updatedAt: string;
	claimedAt?: string;
	deliveredAt?: string;
	error?: string;
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

export type ArchitectRequestStatus = "pending" | "claimed" | "completed";

export interface ArchitectRequest {
	id: number;
	senderSessionId: string;
	body: string;
	status: ArchitectRequestStatus;
	createdAt: string;
	claimedAt?: string;
	claimToken?: string;
	completedAt?: string;
}

export interface PostArchitectRequestInput {
	senderSessionId: string;
	body: string;
}

export interface EnqueueStoredRuntimeMailboxMessageInput extends EnqueueRuntimeMailboxMessageInput {
	message: unknown;
	updatedAt?: string;
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
	archivedAt?: string;
	isArchived?: boolean;
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
	runtime_instance_id: string | null;
	session_path: string | null;
	session_path_asserted_at: string | null;
	updated_at: string;
};

type RuntimeMailboxListedRow = {
	recipient_session_id: string;
	recipient_agent_id_key: string;
	pid: number;
	runtime_instance_id: string | null;
	session_path: string | null;
	session_path_asserted_at: string | null;
	updated_at: string;
};

type PendingRuntimeMailboxStoreRefRow = {
	store_data: string | null;
	store_message_id: string | null;
	store_session_path: string | null;
};

export interface RuntimeMailboxListener {
	sessionId: string;
	agentId: string | null;
	pid: number;
	sessionPath: string | undefined;
	updatedAt: string;
}

export interface RuntimeMailboxRegistrationOptions {
	isRuntimeProcessAlive?: (pid: number) => boolean;
	reconcileRuntimeReplacement?: boolean;
	runtimeInstanceId?: string;
}

const RUNTIME_PROCESS_INSTANCE_ID = JSON.stringify(readProcessIdentity(process.pid));

const UPSERT_RUNTIME_MAILBOX_LISTENER_SQL = `
	INSERT INTO runtime_mailbox_listeners (
		recipient_session_id,
		recipient_agent_id_key,
		pid,
		runtime_instance_id,
		session_path,
		session_path_asserted_at,
		updated_at
	)
	VALUES (?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(recipient_session_id, recipient_agent_id_key) DO UPDATE SET
		pid = excluded.pid,
		runtime_instance_id = excluded.runtime_instance_id,
		session_path = excluded.session_path,
		session_path_asserted_at = excluded.session_path_asserted_at,
		updated_at = excluded.updated_at
`;

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
	archived_at: string | null;
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
	archived_at: string | null;
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
		// Serialize against session relocation so the inserted row cannot move
		// before its canonical ID is read back.
		db.exec("BEGIN IMMEDIATE");
		try {
			const storedMessage = db
				.prepare("SELECT 1 FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
				.get(input.storeRef.sessionPath, input.storeRef.messageId);
			if (!storedMessage) {
				throw new Error(
					`Runtime mailbox store reference does not exist: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`,
				);
			}
			const now = new Date().toISOString();
			const insert = db
				.prepare(
					`
				INSERT OR IGNORE INTO runtime_mailbox_messages (
					recipient_session_id,
					recipient_agent_id,
					sender_session_id,
					sender_agent_id,
					kind,
					body,
					store_session_path,
					store_message_id,
					status,
					created_at,
					updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
				`,
				)
				.run(
					input.recipient.sessionId,
					input.recipient.agentId,
					input.sender.sessionId,
					input.sender.agentId,
					input.kind,
					"",
					input.storeRef.sessionPath,
					input.storeRef.messageId,
					now,
					now,
				);
			const row = db
				.prepare(
					`SELECT id, recipient_session_id, recipient_agent_id, sender_session_id, sender_agent_id, kind
					 FROM runtime_mailbox_messages
					 WHERE store_session_path = ? AND store_message_id = ?`,
				)
				.get(input.storeRef.sessionPath, input.storeRef.messageId) as
				| {
						id: number;
						recipient_session_id: string;
						recipient_agent_id: string | null;
						sender_session_id: string | null;
						sender_agent_id: string | null;
						kind: string;
				  }
				| undefined;
			if (!row) throw new Error("Runtime mailbox enqueue did not create or find the transport row");
			const sameAddress =
				row.recipient_session_id === input.recipient.sessionId &&
				row.recipient_agent_id === input.recipient.agentId;
			const sameSender =
				row.sender_session_id === input.sender.sessionId && row.sender_agent_id === input.sender.agentId;
			if (!sameAddress || !sameSender || row.kind !== input.kind) {
				throw new Error(
					`Runtime mailbox store reference conflicts with existing runtime mailbox row: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`,
				);
			}
			const listener = insert.changes > 0 ? readRuntimeMailboxListenerRow(db, input.recipient) : undefined;
			db.exec("COMMIT");
			return { id: row.id, listener };
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
	notifyRuntimeMailboxListener(result.listener);
	return result.id;
}

export function enqueueStoredRuntimeMailboxMessage(
	controlDbPath: string,
	input: EnqueueStoredRuntimeMailboxMessageInput,
): number {
	validateMailboxPayload(
		input.message,
		`multi_agent_mailbox_messages:${input.storeRef.sessionPath}#${input.storeRef.messageId}`,
	);
	const result = withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => persistStoredRuntimeMailboxMessage(db, input)),
	);
	notifyRuntimeMailboxListener(result.listener);
	return result.id;
}

function persistStoredRuntimeMailboxMessage(db: SqliteDatabase, input: EnqueueStoredRuntimeMailboxMessageInput) {
	const now = input.updatedAt ?? new Date().toISOString();
	persistImmutableMailboxPayload(db, input, now);
	const inserted = insertRuntimeMailboxTransport(db, input, now);
	const row = db
		.prepare(
			`SELECT id, recipient_session_id, recipient_agent_id, sender_session_id, sender_agent_id, kind
			 FROM runtime_mailbox_messages WHERE store_session_path = ? AND store_message_id = ?`,
		)
		.get(input.storeRef.sessionPath, input.storeRef.messageId) as RuntimeMailboxRow | undefined;
	if (!row) throw new Error("Stored runtime mailbox enqueue did not persist its transport row");
	assertStoredRuntimeMailboxIdentity(row, input);
	return {
		id: row.id,
		listener: inserted.changes > 0 ? readRuntimeMailboxListenerRow(db, input.recipient) : undefined,
	};
}

function persistImmutableMailboxPayload(
	db: SqliteDatabase,
	input: EnqueueStoredRuntimeMailboxMessageInput,
	now: string,
): void {
	const serialized = JSON.stringify(input.message);
	const existing = db
		.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
		.get(input.storeRef.sessionPath, input.storeRef.messageId) as { data: string } | undefined;
	if (existing && existing.data !== serialized) {
		throw new Error(`Mailbox message ID collision: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`);
	}
	db.prepare(
		`INSERT OR IGNORE INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
		 VALUES (?, ?, ?, ?)`,
	).run(input.storeRef.sessionPath, input.storeRef.messageId, serialized, now);
}

function insertRuntimeMailboxTransport(
	db: SqliteDatabase,
	input: EnqueueStoredRuntimeMailboxMessageInput,
	now: string,
) {
	return db
		.prepare(
			`INSERT OR IGNORE INTO runtime_mailbox_messages (
				recipient_session_id, recipient_agent_id, sender_session_id, sender_agent_id,
				kind, body, store_session_path, store_message_id, status, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, '', ?, ?, 'pending', ?, ?)`,
		)
		.run(
			input.recipient.sessionId,
			input.recipient.agentId,
			input.sender.sessionId,
			input.sender.agentId,
			input.kind,
			input.storeRef.sessionPath,
			input.storeRef.messageId,
			now,
			now,
		);
}

function assertStoredRuntimeMailboxIdentity(
	row: RuntimeMailboxRow,
	input: EnqueueStoredRuntimeMailboxMessageInput,
): void {
	const addressMatches =
		row.recipient_session_id === input.recipient.sessionId && row.recipient_agent_id === input.recipient.agentId;
	const senderMatches =
		row.sender_session_id === input.sender.sessionId && row.sender_agent_id === input.sender.agentId;
	if (addressMatches && senderMatches && row.kind === input.kind) return;
	throw new Error(
		`Runtime mailbox store reference conflicts with existing runtime mailbox row: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`,
	);
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
		let claimedRows: RuntimeMailboxRow[] = [];
		let claimedAt: string | undefined;
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
			claimedAt = now;
			claimedRows = rows;
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
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		return claimedRows.map((row) =>
			runtimeMailboxMessageFromRow(db, {
				...row,
				status: "claimed",
				claimed_at: claimedAt ?? row.claimed_at,
				updated_at: claimedAt ?? row.updated_at,
			}),
		);
	});
}

export function readRuntimeMailboxMessageForDelivery(
	controlDbPath: string,
	id: number,
): { message: RuntimeMailboxMessage; payloadData?: string; payloadValid: boolean } | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db.prepare("SELECT * FROM runtime_mailbox_messages WHERE id = ?").get(id) as
			| RuntimeMailboxRow
			| undefined;
		if (!row) return undefined;
		const storeRef = requireRuntimeMailboxStoreRef(row, `runtime_mailbox_messages:${id}`);
		const store = db
			.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
			.get(storeRef.sessionPath, storeRef.messageId) as { data: string } | undefined;
		if (!store) {
			throw new Error(`Runtime mailbox store reference is missing: ${storeRef.sessionPath}#${storeRef.messageId}`);
		}
		const parsed = parseStoredJsonObject(store.data, "runtime_mailbox_delivery");
		validateMailboxPayload(parsed, "runtime_mailbox_delivery");
		const storedOverride = {
			body: requireStringField(parsed, "body", "runtime_mailbox_delivery"),
			fileRefs: parseFileRefs(parsed.fileRefs, "runtime_mailbox_delivery"),
			targetCheckpoint: parseSteeringCheckpoint(parsed.targetCheckpoint, "runtime_mailbox_delivery"),
		};
		return {
			message: runtimeMailboxMessageFromRow(db, row, storedOverride),
			payloadData: store.data,
			payloadValid: parsed.status === "pending",
		};
	});
}

export function consumeRuntimeMailboxMessage(controlDbPath: string, id: number): boolean {
	return withControlDb(controlDbPath, (db) => {
		return withImmediateTransaction(db, () => {
			const row = db
				.prepare(
					`SELECT status, store_session_path, store_message_id
					 FROM runtime_mailbox_messages
					 WHERE id = ?`,
				)
				.get(id) as
				| { status: string; store_session_path: string | null; store_message_id: string | null }
				| undefined;
			if (!row) return false;
			const storeRef = requireRuntimeMailboxStoreRef(row, `runtime_mailbox_messages:${id}`);
			const store = db
				.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
				.get(storeRef.sessionPath, storeRef.messageId) as { data: string } | undefined;
			if (!store) {
				throw new Error(
					`Runtime mailbox store reference is missing: ${storeRef.sessionPath}#${storeRef.messageId}`,
				);
			}
			const parsed = parseStoredJsonObject(store.data, "runtime_mailbox_consume");
			validateMailboxPayload(parsed, "runtime_mailbox_consume");
			if (parsed.status === "pending") return false;
			if (parsed.status !== "delivered") return false;
			if (row.status === "delivered") return true;
			if (row.status !== "pending" && row.status !== "claimed") return false;
			const now = new Date().toISOString();
			const updated = db
				.prepare(
					`UPDATE runtime_mailbox_messages
					 SET status = 'delivered', delivered_at = ?, updated_at = ?
					 WHERE id = ? AND status IN ('pending', 'claimed')`,
				)
				.run(now, now, id);
			if (updated.changes !== 1) return false;
			return true;
		});
	});
}

export function deliverRuntimeMailboxMessage(controlDbPath: string, id: number, expectedPayloadData?: string): boolean {
	return withControlDb(controlDbPath, (db) => {
		return withImmediateTransaction(db, () => {
			const row = db
				.prepare(
					`SELECT status, store_session_path, store_message_id
					 FROM runtime_mailbox_messages
					 WHERE id = ?`,
				)
				.get(id) as
				| { status: string; store_session_path: string | null; store_message_id: string | null }
				| undefined;
			if (!row || row.status === "delivered") return row?.status === "delivered";
			if (row.status !== "pending" && row.status !== "claimed") return false;
			const now = new Date().toISOString();
			const storeRef = requireRuntimeMailboxStoreRef(row, `runtime_mailbox_messages:${id}`);
			const store = db
				.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
				.get(storeRef.sessionPath, storeRef.messageId) as { data: string } | undefined;
			if (!store) {
				throw new Error(
					`Runtime mailbox store reference is missing: ${storeRef.sessionPath}#${storeRef.messageId}`,
				);
			}
			const parsed = parseStoredJsonObject(store.data, "runtime_mailbox_delivery");
			validateMailboxPayload(parsed, "runtime_mailbox_delivery");
			if (
				expectedPayloadData !== undefined &&
				store?.data !== expectedPayloadData &&
				parsed.status !== "delivered"
			) {
				return false;
			}
			if (parsed.status === "delivered") {
				const updatedTransport = db
					.prepare(
						`UPDATE runtime_mailbox_messages
						 SET status = 'delivered', delivered_at = ?, updated_at = ?
						 WHERE id = ? AND status IN ('pending', 'claimed')`,
					)
					.run(now, now, id);
				if (updatedTransport.changes !== 1) throw new Error(`Runtime mailbox delivery lost transport row ${id}`);
				return true;
			}
			if (parsed.status !== "pending") return false;
			const updatedStore = db
				.prepare(
					`UPDATE multi_agent_mailbox_messages
					 SET data = ?, updated_at = ?
					 WHERE session_path = ? AND message_id = ?`,
				)
				.run(
					JSON.stringify({ ...parsed, status: "delivered", updatedAt: now }),
					now,
					storeRef.sessionPath,
					storeRef.messageId,
				);
			if (updatedStore.changes !== 1) throw new Error(`Runtime mailbox delivery lost store row ${id}`);
			const updatedTransport = db
				.prepare(
					`UPDATE runtime_mailbox_messages
					 SET status = 'delivered', delivered_at = ?, updated_at = ?
					 WHERE id = ? AND status IN ('pending', 'claimed')`,
				)
				.run(now, now, id);
			if (updatedTransport.changes !== 1) throw new Error(`Runtime mailbox delivery lost transport row ${id}`);
			return true;
		});
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

function withImmediateTransaction<T>(db: SqliteDatabase, operation: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = operation();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export function registerRuntimeMailboxListener(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	pid: number,
	sessionPath?: string,
	options: RuntimeMailboxRegistrationOptions = {},
): void {
	withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () =>
			registerRuntimeMailboxListenerInTransaction(db, recipient, pid, sessionPath, options),
		),
	);
}

function registerRuntimeMailboxListenerInTransaction(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	pid: number,
	sessionPath: string | undefined,
	options: RuntimeMailboxRegistrationOptions,
): void {
	const nowIso = new Date().toISOString();
	const runtimeInstanceId = options.runtimeInstanceId ?? RUNTIME_PROCESS_INSTANCE_ID;
	const existingListener = readRuntimeMailboxListenerRow(db, recipient);
	const runtimeOwnerChanged =
		existingListener?.pid !== pid || existingListener?.runtime_instance_id !== runtimeInstanceId;
	const shouldReconcileReplacement =
		recipient.agentId === null && options.reconcileRuntimeReplacement !== false && runtimeOwnerChanged;
	if (shouldReconcileReplacement) {
		assertRuntimeReplacementAllowed(db, recipient.sessionId, existingListener, pid, runtimeInstanceId, options);
	}
	if (recipient.agentId === null) {
		retireSupersededMainRuntimeMailboxListeners(db, recipient.sessionId, pid, nowIso);
	}
	upsertRuntimeMailboxListenerRow(db, recipient, pid, sessionPath, runtimeInstanceId, nowIso);
	if (recipient.agentId === null) {
		upsertSessionHealthForListener(db, recipient.sessionId, pid, nowIso, shouldReconcileReplacement);
	}
}

function assertRuntimeReplacementAllowed(
	db: SqliteDatabase,
	sessionId: string,
	existingListener: RuntimeMailboxListenerRow | undefined,
	pid: number,
	runtimeInstanceId: string,
	options: RuntimeMailboxRegistrationOptions,
): void {
	const existingOwnerPid = existingListener?.pid ?? readSessionHealthRow(db, sessionId)?.pid;
	if (existingOwnerPid === null || existingOwnerPid === undefined) return;
	if (existingListener?.runtime_instance_id === runtimeInstanceId) return;
	if (existingListener?.runtime_instance_id) {
		try {
			if (!isProcessIdentityAlive(parseProcessIdentity(existingListener.runtime_instance_id))) return;
		} catch {
			if (existingOwnerPid === pid) return;
		}
	}
	const isRuntimeProcessAlive = options.isRuntimeProcessAlive ?? isPiRuntimeProcessAlive;
	if (!isRuntimeProcessAlive(existingOwnerPid)) return;
	const cwd = existingListener ? readVerifiedSessionCwd(db, sessionId, existingListener) : undefined;
	const processContext = cwd ? `PID ${existingOwnerPid}, cwd ${cwd}` : `PID ${existingOwnerPid}`;
	throw new Error(
		`Cannot continue session ${sessionId} because it is open in another Pi process (${processContext}). Close that Pi session, run pi to start a new session, or use pi -r to choose another.`,
	);
}

function readVerifiedSessionCwd(
	db: SqliteDatabase,
	sessionId: string,
	listener: RuntimeMailboxListenerRow,
): string | undefined {
	const sessionPath = trustedRuntimeMailboxSessionPath(listener);
	if (!sessionPath) return undefined;
	const row = db
		.prepare("SELECT cwd FROM session_metadata WHERE session_path = ? AND id = ?")
		.get(sessionPath, sessionId) as { cwd: string } | undefined;
	return row?.cwd;
}

function upsertRuntimeMailboxListenerRow(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	pid: number,
	sessionPath: string | undefined,
	runtimeInstanceId: string,
	nowIso: string,
): void {
	db.prepare(UPSERT_RUNTIME_MAILBOX_LISTENER_SQL).run(
		recipient.sessionId,
		runtimeMailboxAgentIdKey(recipient.agentId),
		pid,
		runtimeInstanceId,
		sessionPath ?? null,
		sessionPath ? nowIso : null,
		nowIso,
	);
}

export function retireRuntimeMailboxListener(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	pid: number,
): boolean {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => retireRuntimeMailboxListenerRow(db, recipient, pid, new Date().toISOString())),
	);
}

function retireRuntimeMailboxListenerRow(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	pid: number,
	nowIso: string,
): boolean {
	const result = db
		.prepare(
			`
			DELETE FROM runtime_mailbox_listeners
			WHERE recipient_session_id = ?
				AND recipient_agent_id_key = ?
				AND pid = ?
			`,
		)
		.run(recipient.sessionId, runtimeMailboxAgentIdKey(recipient.agentId), pid);
	const retired = Number(result.changes) > 0;
	if (retired && recipient.agentId === null) {
		retireSessionHealthForListener(db, recipient.sessionId, pid, nowIso);
	}
	return retired;
}

function listSupersededMainSessionIds(db: SqliteDatabase, currentSessionId: string, pid: number): string[] {
	const rows = db
		.prepare(
			`
			SELECT recipient_session_id
			FROM runtime_mailbox_listeners
			WHERE recipient_agent_id_key = ''
				AND pid = ?
				AND recipient_session_id <> ?
			`,
		)
		.all(pid, currentSessionId) as Array<{ recipient_session_id: string }>;
	return rows.map((row) => row.recipient_session_id);
}

function retireSupersededMainRuntimeMailboxListeners(
	db: SqliteDatabase,
	currentSessionId: string,
	pid: number,
	nowIso: string,
): void {
	const supersededSessionIds = listSupersededMainSessionIds(db, currentSessionId, pid);
	if (supersededSessionIds.length === 0) return;
	db.prepare(
		`
		DELETE FROM runtime_mailbox_listeners
		WHERE recipient_agent_id_key = ''
			AND pid = ?
			AND recipient_session_id <> ?
		`,
	).run(pid, currentSessionId);
	for (const sessionId of supersededSessionIds) {
		retireSessionHealthForListener(db, sessionId, pid, nowIso);
	}
}

function retireSessionHealthForListener(db: SqliteDatabase, sessionId: string, pid: number, nowIso: string): void {
	const existing = readSessionHealthRow(db, sessionId);
	if (!existing || existing.pid !== pid) return;
	writeSessionHealthRow(db, endSessionHealth(existing, nowIso));
}

function readRuntimeMailboxListenerRow(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
): RuntimeMailboxListenerRow | undefined {
	return db
		.prepare(
			`
			SELECT pid, runtime_instance_id, session_path, session_path_asserted_at, updated_at
			FROM runtime_mailbox_listeners
			WHERE recipient_session_id = ? AND recipient_agent_id_key = ?
			`,
		)
		.get(recipient.sessionId, runtimeMailboxAgentIdKey(recipient.agentId)) as RuntimeMailboxListenerRow | undefined;
}

export function readRuntimeMailboxListener(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
): { pid: number; sessionPath: string | undefined; updatedAt: string } | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = readRuntimeMailboxListenerRow(db, recipient);
		if (!row) return undefined;
		return { pid: row.pid, sessionPath: trustedRuntimeMailboxSessionPath(row), updatedAt: row.updated_at };
	});
}

/**
 * Resolve this process's own main-thread runtime coordination address from the
 * persisted listener registration, not from mutable UI/store context.
 *
 * Matches the single listener row whose exact process identity (PID + /proc
 * start ticks) equals the current runtime, whose recipient is the main thread
 * (`recipient_agent_id_key = ''`), and whose main session path is freshly
 * asserted. Zero or multiple matches are rejected (returns undefined) so wait
 * primitives never poll a selected child's address.
 */
export function resolveOwnMainRuntimeCoordinationRecipient(
	controlDbPath: string,
): RuntimeMailboxAddress | undefined {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`
				SELECT recipient_session_id
				FROM runtime_mailbox_listeners
				WHERE recipient_agent_id_key = ''
					AND pid = ?
					AND runtime_instance_id = ?
					AND session_path IS NOT NULL
					AND session_path_asserted_at = updated_at
				`,
			)
			.all(process.pid, RUNTIME_PROCESS_INSTANCE_ID) as Array<{ recipient_session_id: string }>;
		if (rows.length !== 1) return undefined;
		return { agentId: null, sessionId: rows[0].recipient_session_id };
	});
}

export function listRuntimeMailboxListeners(controlDbPath: string): RuntimeMailboxListener[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`
				SELECT
					recipient_session_id,
					recipient_agent_id_key,
					pid,
					runtime_instance_id,
					session_path,
					session_path_asserted_at,
					updated_at
				FROM runtime_mailbox_listeners
				`,
			)
			.all() as RuntimeMailboxListedRow[];
		return rows.map(runtimeMailboxListenerFromRow);
	});
}

function runtimeMailboxListenerFromRow(row: RuntimeMailboxListedRow): RuntimeMailboxListener {
	return {
		sessionId: row.recipient_session_id,
		agentId: row.recipient_agent_id_key === "" ? null : row.recipient_agent_id_key,
		pid: row.pid,
		sessionPath: trustedRuntimeMailboxSessionPath(row),
		updatedAt: row.updated_at,
	};
}

function trustedRuntimeMailboxSessionPath(
	row: Pick<RuntimeMailboxListenerRow, "session_path" | "session_path_asserted_at" | "updated_at">,
): string | undefined {
	return row.session_path !== null && row.session_path_asserted_at === row.updated_at ? row.session_path : undefined;
}

export function postArchitectRequest(controlDbPath: string, input: PostArchitectRequestInput): number {
	const body = input.body.trim();
	if (!body) {
		throw new Error("Architect request body must be non-empty");
	}
	return withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		const result = db
			.prepare(
				`
				INSERT INTO architect_requests (sender_session_id, body, status, created_at)
				VALUES (?, ?, 'pending', ?)
				`,
			)
			.run(input.senderSessionId, body, now);
		return Number(result.lastInsertRowid);
	});
}

type ArchitectRequestRow = {
	id: number;
	sender_session_id: string;
	body: string;
	status: ArchitectRequestStatus;
	created_at: string;
	claimed_at: string | null;
	claim_token: string | null;
	completed_at: string | null;
};

function architectRequestFromRow(row: ArchitectRequestRow): ArchitectRequest {
	return {
		id: row.id,
		senderSessionId: row.sender_session_id,
		body: row.body,
		status: row.status,
		createdAt: row.created_at,
		claimedAt: row.claimed_at ?? undefined,
		claimToken: row.claim_token ?? undefined,
		completedAt: row.completed_at ?? undefined,
	};
}

export function listPendingArchitectRequests(controlDbPath: string, limit = 20): ArchitectRequest[] {
	return withControlDb(controlDbPath, (db) =>
		(
			db
				.prepare(
					`SELECT id, sender_session_id, body, status, created_at, claimed_at, claim_token, completed_at
					 FROM architect_requests
					 WHERE status = 'pending'
					 ORDER BY id ASC
					 LIMIT ?`,
				)
				.all(Math.max(1, Math.floor(limit))) as ArchitectRequestRow[]
		).map(architectRequestFromRow),
	);
}

export function claimPendingArchitectRequests(
	controlDbPath: string,
	claimToken: string,
	limit = 20,
): ArchitectRequest[] {
	return withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		db.exec("BEGIN IMMEDIATE");
		try {
			db.prepare(
				`UPDATE architect_requests
				 SET status = 'pending', claimed_at = NULL, claim_token = NULL
				 WHERE status = 'claimed' AND julianday(claimed_at) < julianday(?, '-2 minutes')`,
			).run(now);
			const rows = db
				.prepare(
					`SELECT id, sender_session_id, body, status, created_at, claimed_at, claim_token, completed_at
					 FROM architect_requests
					 WHERE status = 'pending'
					 ORDER BY id ASC
					 LIMIT ?`,
				)
				.all(Math.max(1, Math.floor(limit))) as ArchitectRequestRow[];
			for (const row of rows) {
				db.prepare(
					`UPDATE architect_requests
					 SET status = 'claimed', claimed_at = ?, claim_token = ?
					 WHERE id = ? AND status = 'pending'`,
				).run(now, claimToken, row.id);
			}
			db.exec("COMMIT");
			return rows.map((row) =>
				architectRequestFromRow({ ...row, status: "claimed", claimed_at: now, claim_token: claimToken }),
			);
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

export function renewArchitectRequestClaims(controlDbPath: string, requestIds: number[], claimToken: string): void {
	if (requestIds.length === 0) return;
	withControlDb(controlDbPath, (db) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const now = new Date().toISOString();
			const renew = db.prepare(
				`UPDATE architect_requests
				 SET claimed_at = ?
				 WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
			);
			for (const requestId of requestIds) {
				const result = renew.run(now, requestId, claimToken);
				if (result.changes === 1) continue;
				const row = db.prepare("SELECT status, claim_token FROM architect_requests WHERE id = ?").get(requestId) as
					| { status: string; claim_token: string | null }
					| undefined;
				if (row?.status === "completed") continue;
				throw new Error(`Architect request claim lost: ${requestId}`);
			}
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

export function completeArchitectRequest(
	controlDbPath: string,
	requestId: number,
	claimToken: string,
	senderSessionId?: string,
): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`UPDATE architect_requests
			 SET status = 'completed', completed_at = ?
			 WHERE id = ? AND status = 'claimed' AND claim_token = ?
			   AND (? IS NULL OR sender_session_id = ?)`,
		).run(new Date().toISOString(), requestId, claimToken, senderSessionId ?? null, senderSessionId ?? null);
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
					AND sender_agent_id IS NULL
					AND sender_session_id <> ?
				LIMIT 1
				`,
			)
			.get(cursor, recipient.sessionId) as { present: number } | undefined;
		return row !== undefined;
	});
}

function hasDeliverableRuntimeMailboxMessage(db: SqliteDatabase, recipient: RuntimeMailboxAddress): boolean {
	const rows = db
		.prepare(
			`
			SELECT
				runtime.store_session_path,
				runtime.store_message_id,
				stored.data AS store_data
			FROM runtime_mailbox_messages AS runtime
			JOIN multi_agent_mailbox_messages AS stored
				ON stored.session_path = runtime.store_session_path
				AND stored.message_id = runtime.store_message_id
			WHERE runtime.status = 'pending'
				AND runtime.store_session_path IS NOT NULL
				AND runtime.store_message_id IS NOT NULL
				AND runtime.recipient_session_id = ?
				AND ((? IS NULL AND runtime.recipient_agent_id IS NULL) OR runtime.recipient_agent_id = ?)
			ORDER BY runtime.id ASC
			`,
		)
		.all(recipient.sessionId, recipient.agentId, recipient.agentId) as PendingRuntimeMailboxStoreRefRow[];
	return rows.some((row) => {
		const message = parseJsonObject(row.store_data ?? "");
		return message?.status === "pending" && !isLifecycleNotificationPayload(message);
	});
}

function isLifecycleNotificationPayload(message: Record<string, unknown>): boolean {
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
	withControlDb(controlDbPath, (db) => writeSessionHealthRow(db, health));
}

function writeSessionHealthRow(db: SqliteDatabase, health: SessionHealthRecord): void {
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

function upsertSessionHealthForListener(
	db: SqliteDatabase,
	sessionId: string,
	pid: number,
	nowIso: string,
	forceNewGeneration: boolean,
): void {
	const existing = readSessionHealthRow(db, sessionId) ?? emptySessionHealth(sessionId, nowIso);
	const sameGeneration = !forceNewGeneration && existing.pid === pid && existing.agentGeneration > 0;
	const agentGeneration = sameGeneration ? existing.agentGeneration : existing.agentGeneration + 1;
	writeSessionHealthRow(db, {
		...existing,
		pid,
		agentGeneration,
		lastActiveAt: nowIso,
		lastCheckedAt: nowIso,
		checkStatus: "ok",
		checkedGeneration: agentGeneration,
		checkLatencyMs: 0,
		updatedAt: nowIso,
	});
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
	if (!listener || process.platform === "win32" || !isVerifiedPiRuntimeProcess(listener.pid)) {
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
		const row = db
			.prepare("SELECT store_session_path, store_message_id FROM runtime_mailbox_messages WHERE id = ?")
			.get(id) as Pick<RuntimeMailboxRow, "store_session_path" | "store_message_id"> | undefined;
		if (!row) return;
		requireRuntimeMailboxStoreRef(row, `runtime_mailbox_messages:${id}`);
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

function runtimeMailboxMessageFromRow(
	db: SqliteDatabase,
	row: RuntimeMailboxRow,
	storedOverride?: {
		body: string;
		fileRefs?: AgentFileReference[];
		targetCheckpoint?: RuntimeMailboxMessage["targetCheckpoint"];
	},
): RuntimeMailboxMessage {
	const storeRef = requireRuntimeMailboxStoreRef(row, `runtime_mailbox_messages:${row.id}`);
	const stored = storedOverride ?? readReferencedStoreMessage(db, row);
	return {
		id: row.id,
		recipient: { agentId: row.recipient_agent_id, sessionId: row.recipient_session_id },
		sender: { agentId: row.sender_agent_id, sessionId: row.sender_session_id ?? "" },
		kind: toRuntimeMailboxMessageKind(row.kind),
		body: stored.body,
		fileRefs: stored.fileRefs,
		targetCheckpoint: stored.targetCheckpoint,
		storeRef,
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
): { body: string; fileRefs?: AgentFileReference[]; targetCheckpoint?: RuntimeMailboxMessage["targetCheckpoint"] } {
	const storeRef = requireRuntimeMailboxStoreRef(row, `runtime_mailbox_messages:${row.id}`);
	const stored = db
		.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
		.get(storeRef.sessionPath, storeRef.messageId) as { data: string } | undefined;
	if (!stored) {
		throw new Error(`Runtime mailbox store reference is missing: ${storeRef.sessionPath}#${storeRef.messageId}`);
	}
	const data = parseStoredJsonObject(stored.data, "runtime_mailbox_store");
	validateMailboxPayload(data, "runtime_mailbox_store");
	return {
		body: requireStringField(data, "body", "runtime_mailbox_store"),
		fileRefs: parseFileRefs(data.fileRefs, "runtime_mailbox_store"),
		targetCheckpoint: parseSteeringCheckpoint(data.targetCheckpoint, "runtime_mailbox_store"),
	};
}

function requireRuntimeMailboxStoreRef(
	row: Pick<RuntimeMailboxRow, "store_session_path" | "store_message_id">,
	context: string,
): RuntimeMailboxStoreRef {
	if (!row.store_session_path || !row.store_message_id) {
		throw new Error(`Invalid runtime mailbox row at ${context}: storeRef is required`);
	}
	return { messageId: row.store_message_id, sessionPath: row.store_session_path };
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

function parseSteeringCheckpoint(value: unknown, context: string): RuntimeMailboxMessage["targetCheckpoint"] {
	if (value === undefined) return undefined;
	if (value === "next_model_call" || value === "after_tool_result" || value === "when_waiting") return value;
	throw new Error(`Invalid steering checkpoint at ${context}`);
}

function parseFileRefs(value: unknown, context: string): AgentFileReference[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new Error(`Invalid file references at ${context}: expected an array`);
	}
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(`Invalid file reference at ${context}[${index}]`);
		}
		const ref = item as { path?: unknown; label?: unknown };
		if (typeof ref.path !== "string" || !isAbsolute(ref.path)) {
			throw new Error(`Invalid file reference at ${context}[${index}]: path must be absolute`);
		}
		if (ref.label !== undefined && typeof ref.label !== "string") {
			throw new Error(`Invalid file reference at ${context}[${index}]: label must be a string`);
		}
		return {
			path: ref.path,
			label: ref.label,
		};
	});
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

export function removeSessionMetadata(controlDbPath: string, sessionPath: string): void {
	withControlDb(controlDbPath, (db) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			db.prepare("DELETE FROM named_sessions WHERE session_path = ?").run(sessionPath);
			db.prepare("DELETE FROM session_metadata WHERE session_path = ?").run(sessionPath);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
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
			relocateMultiAgentSessionRows(db, "multi_agent_mailbox_messages", oldSessionPath, newSessionPath, now);
			relocateSessionPathPrimaryKey(db, "multi_agent_counters_v2", oldSessionPath, newSessionPath, now);
			relocateRuntimeMailboxListenerPaths(db, oldSessionPath, newSessionPath);
			relocateRuntimeMailboxMessagePaths(db, oldSessionPath, newSessionPath, now);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

function relocateRuntimeMailboxMessagePaths(
	db: SqliteDatabase,
	oldSessionPath: string,
	newSessionPath: string,
	nowIso: string,
): void {
	// The relocated durable store replaced the entire destination store, so every
	// destination transport reference is stale before source transports move in.
	db.prepare("DELETE FROM runtime_mailbox_messages WHERE store_session_path = ?").run(newSessionPath);
	db.prepare(
		`
		UPDATE runtime_mailbox_messages
		SET store_session_path = ?, updated_at = ?
		WHERE store_session_path = ?
		`,
	).run(newSessionPath, nowIso, oldSessionPath);
}

function relocateRuntimeMailboxListenerPaths(db: SqliteDatabase, oldSessionPath: string, newSessionPath: string): void {
	db.prepare("UPDATE runtime_mailbox_listeners SET session_path = ? WHERE session_path = ?").run(
		newSessionPath,
		oldSessionPath,
	);
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
	table: "multi_agent_agents" | "multi_agent_mailbox_messages",
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
		const archivedAt = metadata.archivedAt ?? preserved?.archived_at ?? null;
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
				archived_at,
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
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_path) DO UPDATE SET
				id = excluded.id,
				cwd = excluded.cwd,
				name = excluded.name,
				parent_session_path = excluded.parent_session_path,
				archived_at = excluded.archived_at,
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
			archivedAt,
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
			SELECT archived_at, goal_json, is_subagent, subagent_name
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
					archived_at,
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
	return listSessionMetadataByArchiveState(controlDbPath);
}

export function listActiveSessionMetadata(controlDbPath: string): SessionMetadata[] {
	return listSessionMetadataByArchiveState(controlDbPath, false);
}

export function listArchivedSessionMetadata(controlDbPath: string): SessionMetadata[] {
	return listSessionMetadataByArchiveState(controlDbPath, true);
}

function listSessionMetadataByArchiveState(controlDbPath: string, archived?: boolean): SessionMetadata[] {
	return withControlDb(controlDbPath, (db) => {
		const archiveClause =
			archived === undefined ? "" : archived ? "WHERE archived_at IS NOT NULL" : "WHERE archived_at IS NULL";
		const rows = db
			.prepare(
				`
				SELECT
					session_path,
					id,
					cwd,
					name,
					parent_session_path,
					archived_at,
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
				${archiveClause}
				ORDER BY modified_at DESC, updated_at DESC, session_path DESC
				`,
			)
			.all() as SessionMetadataRow[];
		return rows.map(sessionMetadataFromRow);
	});
}

export function archiveSession(controlDbPath: string, sessionPath: string): void {
	withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		db.prepare("UPDATE session_metadata SET archived_at = ?, updated_at = ? WHERE session_path = ?").run(
			now,
			now,
			sessionPath,
		);
	});
}

export function unarchiveSession(controlDbPath: string, sessionPath: string): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare("UPDATE session_metadata SET archived_at = NULL, updated_at = ? WHERE session_path = ?").run(
			new Date().toISOString(),
			sessionPath,
		);
	});
}

export function archiveSessionsOlderThan(controlDbPath: string, cutoff: Date): string[] {
	return withControlDb(controlDbPath, (db) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const rows = db
				.prepare(
					`SELECT session_path FROM session_metadata
					 WHERE archived_at IS NULL AND is_subagent = 0 AND modified_at < ?
					 ORDER BY modified_at ASC, session_path ASC`,
				)
				.all(cutoff.toISOString()) as Array<{ session_path: string }>;
			const archivedAt = new Date().toISOString();
			db.prepare(
				"UPDATE session_metadata SET archived_at = ?, updated_at = ? WHERE archived_at IS NULL AND is_subagent = 0 AND modified_at < ?",
			).run(archivedAt, archivedAt, cutoff.toISOString());
			db.exec("COMMIT");
			return rows.map((row) => row.session_path);
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

function sessionMetadataFromRow(row: SessionMetadataRow): SessionMetadata {
	return {
		sessionPath: row.session_path,
		id: row.id,
		cwd: row.cwd,
		name: row.name ?? undefined,
		parentSessionPath: row.parent_session_path ?? undefined,
		archivedAt: row.archived_at ?? undefined,
		isArchived: row.archived_at !== null,
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

export interface CreateMultiAgentChildWithRuntimeOwnershipInput extends AcquireMultiAgentRuntimeOwnershipInput {
	agent: object;
}

export interface CreateMultiAgentAttachmentInput {
	agent: AgentSnapshot;
	agentId: string;
	nowIso: string;
	sessionPath: string;
}

export type CreateMultiAgentAttachmentResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_exists" | "parent_not_found" | "permission_broadened" };

export type CreateMultiAgentChildWithRuntimeOwnershipResult =
	| { ok: true; agent: object; ownership: MultiAgentRuntimeOwnership }
	| { ok: false; error: "agent_exists" | "parent_not_found" };

export interface CreateFailedMultiAgentChildInput {
	agent: AgentSnapshot;
	nowIso: string;
	sessionPath: string;
}

export type CreateFailedMultiAgentChildResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_exists" | "parent_not_found" };

export interface MultiAgentRuntimeOwnership {
	sessionPath: string;
	agentId: string;
	processIdentity?: ProcessIdentity;
	owner: { sessionId?: string; agentId: string | null };
}

interface MultiAgentRuntimeOwnershipRow {
	session_path: string;
	agent_id: string;
	process_identity: string | null;
	owner_session_id: string | null;
	owner_agent_id: string | null;
}

export interface MultiAgentRuntimeOwnershipIdentity {
	sessionPath: string;
	agentId: string;
	processIdentity: ProcessIdentity;
	owner: { sessionId: string; agentId: string | null };
}

export interface AcquireMultiAgentRuntimeOwnershipInput extends MultiAgentRuntimeOwnershipIdentity {
	nowIso: string;
}

export type AcquireMultiAgentRuntimeOwnershipResult =
	| { ok: true; ownership: MultiAgentRuntimeOwnership }
	| { ok: false; error: "ownership_held"; current: MultiAgentRuntimeOwnership };

export interface SupervisorRuntimeOwnership {
	processIdentity: ProcessIdentity;
	sessionId: string;
}

export interface AcquireAttachedRuntimeOwnershipInput extends MultiAgentRuntimeOwnershipIdentity {
	nowIso: string;
	supervisor: SupervisorRuntimeOwnership;
}

export type AcquireAttachedRuntimeOwnershipResult =
	| { ok: true; agent: AgentSnapshot; ownership: MultiAgentRuntimeOwnership }
	| { ok: false; error: "agent_not_found" | "invalid_agent" | "ownership_held" | "mutation_mismatch" };

export type ReleaseMultiAgentRuntimeOwnershipInput = MultiAgentRuntimeOwnershipIdentity;

export interface MultiAgentTerminalOutboxRecord {
	sessionPath: string;
	agentId: string;
	terminalRevision: number;
	eventKind: string;
	status: "claimed" | "delivered" | "pending" | "poisoned";
	claimId?: string;
	attemptCount: number;
}

export interface ClaimMultiAgentTerminalOutboxOptions {
	maxAttempts?: number;
	sessionPath?: string;
	staleClaimBefore?: string;
}

export interface CommitMultiAgentLifecycleMutationInput {
	sessionPath: string;
	agentId: string;
	processIdentity: ProcessIdentity;
	owner: { sessionId: string; agentId: string | null };
	requestedLifecycle: string;
	updatedAt: string;
	detachedCancellation?: { outputLabel: string; reason?: string };
}
export type CommitMultiAgentLifecycleMutationResult =
	| { ok: true; agent: Record<string, unknown> }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export interface CommitMultiAgentSteeringMutationInput extends CommitMultiAgentLifecycleMutationInput {
	message: AgentMailboxMessage;
}

export type CommitMultiAgentSteeringMutationResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export interface CommitMultiAgentSteeringDeliveryInput extends CommitMultiAgentLifecycleMutationInput {
	messageId: string;
}

export type CommitMultiAgentSteeringDeliveryResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| {
			ok: false;
			error: "agent_not_found" | "invalid_transition" | "message_not_found" | "mutation_mismatch";
	  };

export interface CommitMultiAgentTerminalMutationInput {
	sessionPath: string;
	agentId: string;
	processIdentity: ProcessIdentity;
	owner: { sessionId: string; agentId: string | null };
	terminalLifecycle: "completed" | "failed" | "aborted";
	eventKind: string;
	agentDetails?: { error?: unknown; result?: unknown };
	updatedAt: string;
}

export type CommitMultiAgentTerminalMutationResult =
	| { ok: true; terminalRevision: number }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export interface FinalizeDetachedJobInput {
	sessionPath: string;
	terminal: DetachedJobTerminalInput;
}

export type FinalizeDetachedJobResult =
	| { ok: true; terminalAgent: AgentSnapshot; terminalRevision: number }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export interface RecoverDeadMultiAgentRuntimeInput {
	expectedOwner: MultiAgentRuntimeOwnershipIdentity;
	nowIso: string;
	supervisor: SupervisorRuntimeOwnership;
}

export type RecoverDeadMultiAgentRuntimeResult =
	| { ok: true; agent: Record<string, unknown>; terminalRevision: number }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "owner_alive" | "mutation_mismatch" };

export interface MultiAgentCounters {
	nextAgentNumber: number;
	nextMessageNumber: number;
}

export interface MultiAgentPersistedState {
	agents: unknown[];
	mailboxMessages: unknown[];
	counters: MultiAgentCounters;
}

export function claimMultiAgentTerminalOutbox(
	controlDbPath: string,
	claimId: string,
	nowIso: string,
	options: ClaimMultiAgentTerminalOutboxOptions = {},
): MultiAgentTerminalOutboxRecord | undefined {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const maxAttempts = options.maxAttempts ?? 5;
			if (options.staleClaimBefore) {
				db.prepare(
					`UPDATE multi_agent_terminal_outbox
					 SET status = CASE WHEN attempt_count >= ? THEN 'poisoned' ELSE 'pending' END,
					 claim_id = NULL, claimed_at = NULL, last_error = 'claim lease expired', updated_at = ?
					 WHERE status = 'claimed' AND claimed_at < ? AND (? IS NULL OR session_path = ?)`,
				).run(
					maxAttempts,
					nowIso,
					options.staleClaimBefore,
					options.sessionPath ?? null,
					options.sessionPath ?? null,
				);
			}
			const row = db
				.prepare(
					`SELECT session_path, agent_id, terminal_revision, event_kind
					 FROM multi_agent_terminal_outbox
					 WHERE status = 'pending' AND attempt_count < ? AND (? IS NULL OR session_path = ?)
					 ORDER BY updated_at LIMIT 1`,
				)
				.get(maxAttempts, options.sessionPath ?? null, options.sessionPath ?? null) as
				| { session_path: string; agent_id: string; terminal_revision: number; event_kind: string }
				| undefined;
			if (!row) return undefined;
			const result = db
				.prepare(
					`UPDATE multi_agent_terminal_outbox SET status = 'claimed', claim_id = ?, claimed_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE session_path = ? AND agent_id = ? AND terminal_revision = ? AND event_kind = ? AND status = 'pending'`,
				)
				.run(claimId, nowIso, nowIso, row.session_path, row.agent_id, row.terminal_revision, row.event_kind);
			if (result.changes !== 1) return undefined;
			return {
				agentId: row.agent_id,
				attemptCount: readTerminalOutboxAttempt(db, row),
				claimId,
				eventKind: row.event_kind,
				sessionPath: row.session_path,
				status: "claimed",
				terminalRevision: row.terminal_revision,
			};
		}),
	);
}

export function failMultiAgentTerminalOutbox(
	controlDbPath: string,
	record: MultiAgentTerminalOutboxRecord,
	error: string,
	nowIso: string,
	options: { maxAttempts?: number } = {},
): boolean {
	const status = record.attemptCount >= (options.maxAttempts ?? 5) ? "poisoned" : "pending";
	return updateClaimedTerminalOutbox(controlDbPath, record, status, nowIso, error);
}

export function deliverMultiAgentTerminalOutbox(
	controlDbPath: string,
	record: MultiAgentTerminalOutboxRecord,
	nowIso: string,
): boolean {
	return updateClaimedTerminalOutbox(controlDbPath, record, "delivered", nowIso);
}

function updateClaimedTerminalOutbox(
	controlDbPath: string,
	record: MultiAgentTerminalOutboxRecord,
	status: "pending" | "delivered" | "poisoned",
	nowIso: string,
	error?: string,
): boolean {
	return withControlDb(
		controlDbPath,
		(db) =>
			db
				.prepare(
					`UPDATE multi_agent_terminal_outbox SET status = ?, claim_id = NULL, claimed_at = NULL, delivered_at = ?, last_error = ?, updated_at = ? WHERE session_path = ? AND agent_id = ? AND terminal_revision = ? AND event_kind = ? AND status = 'claimed' AND claim_id = ?`,
				)
				.run(
					status,
					status === "delivered" ? nowIso : null,
					error ?? null,
					nowIso,
					record.sessionPath,
					record.agentId,
					record.terminalRevision,
					record.eventKind,
					record.claimId ?? null,
				).changes === 1,
	);
}

export function cleanupMultiAgentTerminalOutbox(controlDbPath: string, olderThan: string): number {
	return withControlDb(
		controlDbPath,
		(db) =>
			db
				.prepare(
					`DELETE FROM multi_agent_terminal_outbox
					 WHERE status IN ('delivered', 'poisoned') AND updated_at < ?`,
				)
				.run(olderThan).changes,
	);
}

function readTerminalOutboxAttempt(
	db: SqliteDatabase,
	row: { session_path: string; agent_id: string; terminal_revision: number; event_kind: string },
): number {
	return (
		db
			.prepare(
				`SELECT attempt_count FROM multi_agent_terminal_outbox WHERE session_path = ? AND agent_id = ? AND terminal_revision = ? AND event_kind = ?`,
			)
			.get(row.session_path, row.agent_id, row.terminal_revision, row.event_kind) as { attempt_count: number }
	).attempt_count;
}

export function commitMultiAgentSteeringMutation(
	controlDbPath: string,
	input: CommitMultiAgentSteeringMutationInput,
): CommitMultiAgentSteeringMutationResult {
	validateMailboxPayload(input.message, `multi_agent_mailbox_messages:${input.sessionPath}#${input.message.id}`);
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const row = db
				.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(input.sessionPath, input.agentId) as { data: string } | undefined;
			if (!row) return { ok: false, error: "agent_not_found" };
			const context = `multi_agent_agents:${input.sessionPath}#${input.agentId}`;
			const agent = parseStoredJsonObject(row.data, context);
			validatePersistedAgentPayload(agent, context);
			const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
			if (!runtimeOwnershipMatchesLifecycleMutation(ownership, input)) {
				return { ok: false, error: "mutation_mismatch" };
			}
			if (!canPersistLifecycleTransition(agent.lifecycle, input.requestedLifecycle)) {
				return { ok: false, error: "invalid_transition" };
			}
			const updated = {
				...agent,
				lifecycle: input.requestedLifecycle,
				revision: Number(agent.revision) + 1,
				updatedAt: input.updatedAt,
			};
			persistImmutableMailboxPayload(
				db,
				{
					kind: input.message.kind,
					message: input.message,
					recipient: { agentId: input.agentId, sessionId: input.owner.sessionId },
					sender: input.owner,
					storeRef: { messageId: input.message.id, sessionPath: input.sessionPath },
					updatedAt: input.updatedAt,
				},
				input.updatedAt,
			);
			db.prepare(
				"UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?",
			).run(JSON.stringify(updated), input.updatedAt, input.sessionPath, input.agentId);
			return {
				agent: updated as unknown as AgentSnapshot,
				message: input.message,
				ok: true,
			};
		}),
	);
}

function runtimeOwnerMatches(
	owner: MultiAgentRuntimeOwnershipRow | undefined,
	identity: MultiAgentRuntimeOwnershipIdentity,
): boolean {
	return (
		owner?.process_identity === serializeProcessIdentity(identity.processIdentity) &&
		owner.owner_session_id === identity.owner.sessionId &&
		owner.owner_agent_id === identity.owner.agentId
	);
}

function runtimeOwnershipMatchesLifecycleMutation(
	ownership: MultiAgentRuntimeOwnershipRow | undefined,
	input: CommitMultiAgentLifecycleMutationInput,
): boolean {
	return runtimeOwnerMatches(ownership, input);
}

export function commitMultiAgentSteeringDelivery(
	controlDbPath: string,
	input: CommitMultiAgentSteeringDeliveryInput,
): CommitMultiAgentSteeringDeliveryResult {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const agentRow = db
				.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(input.sessionPath, input.agentId) as { data: string } | undefined;
			if (!agentRow) return { ok: false, error: "agent_not_found" };
			const agentContext = `multi_agent_agents:${input.sessionPath}#${input.agentId}`;
			const agent = parseStoredJsonObject(agentRow.data, agentContext);
			validatePersistedAgentPayload(agent, agentContext);
			const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
			if (!runtimeOwnershipMatchesLifecycleMutation(ownership, input)) {
				return { ok: false, error: "mutation_mismatch" };
			}
			if (!canPersistLifecycleTransition(agent.lifecycle, input.requestedLifecycle)) {
				return { ok: false, error: "invalid_transition" };
			}
			const messageRow = db
				.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
				.get(input.sessionPath, input.messageId) as { data: string } | undefined;
			if (!messageRow) return { ok: false, error: "message_not_found" };
			const messageContext = `multi_agent_mailbox_messages:${input.sessionPath}#${input.messageId}`;
			const message = parseStoredJsonObject(messageRow.data, messageContext);
			validateMailboxPayload(message, messageContext);
			if (message.kind !== "steer" || message.toAgentId !== input.agentId) {
				return { ok: false, error: "message_not_found" };
			}
			const updatedAt = input.updatedAt;
			const updatedAgent = {
				...agent,
				lifecycle: input.requestedLifecycle,
				revision: Number(agent.revision) + 1,
				updatedAt,
			};
			const updatedMessage = { ...message, status: "delivered", updatedAt };
			db.prepare(
				"UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?",
			).run(JSON.stringify(updatedAgent), updatedAt, input.sessionPath, input.agentId);
			db.prepare(
				"UPDATE multi_agent_mailbox_messages SET data = ?, updated_at = ? WHERE session_path = ? AND message_id = ?",
			).run(JSON.stringify(updatedMessage), updatedAt, input.sessionPath, input.messageId);
			return {
				agent: updatedAgent as unknown as AgentSnapshot,
				message: updatedMessage as unknown as AgentMailboxMessage,
				ok: true,
			};
		}),
	);
}

export function commitMultiAgentLifecycleMutation(
	controlDbPath: string,
	input: CommitMultiAgentLifecycleMutationInput,
): CommitMultiAgentLifecycleMutationResult {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const row = db
				.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(input.sessionPath, input.agentId) as { data: string } | undefined;
			if (!row) return { ok: false, error: "agent_not_found" };
			const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
			const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
			const matches =
				ownership?.process_identity === serializeProcessIdentity(input.processIdentity) &&
				ownership.owner_session_id === input.owner.sessionId &&
				ownership.owner_agent_id === input.owner.agentId;
			if (!matches) return { ok: false, error: "mutation_mismatch" };
			if (agent.lifecycle === input.requestedLifecycle) return { ok: true, agent };
			if (!canPersistLifecycleTransition(agent.lifecycle, input.requestedLifecycle))
				return { ok: false, error: "invalid_transition" };
			const updated = {
				...agent,
				lifecycle: input.requestedLifecycle,
				revision: Number(agent.revision) + 1,
				updatedAt: input.updatedAt,
			};
			db.prepare(
				"UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?",
			).run(JSON.stringify(updated), input.updatedAt, input.sessionPath, input.agentId);
			if (input.detachedCancellation) persistDetachedCancellationCommand(db, input, updated.revision);
			return { ok: true, agent: updated };
		}),
	);
}

function persistDetachedCancellationCommand(
	db: SqliteDatabase,
	input: CommitMultiAgentLifecycleMutationInput,
	cancellingRevision: number,
): void {
	const cancellation = input.detachedCancellation;
	if (!cancellation) return;
	const { message, messageId } = buildDetachedCancellationMessage(input, cancellation, cancellingRevision);
	db.prepare(
		`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
		 VALUES (?, ?, ?, ?)`,
	).run(input.sessionPath, messageId, message, input.updatedAt);
	db.prepare(
		`INSERT INTO runtime_mailbox_messages (
			recipient_session_id, recipient_agent_id, sender_session_id, sender_agent_id,
			kind, body, store_session_path, store_message_id, status, created_at, updated_at
		 ) VALUES (?, ?, ?, NULL, 'system', '', ?, ?, 'pending', ?, ?)`,
	).run(
		input.owner.sessionId,
		input.agentId,
		input.owner.sessionId,
		input.sessionPath,
		messageId,
		input.updatedAt,
		input.updatedAt,
	);
}

function buildDetachedCancellationMessage(
	input: CommitMultiAgentLifecycleMutationInput,
	cancellation: NonNullable<CommitMultiAgentLifecycleMutationInput["detachedCancellation"]>,
	cancellingRevision: number,
): { message: string; messageId: string } {
	const messageId = `detached-cancel:${input.agentId}:${cancellingRevision}`;
	const body = JSON.stringify({
		command: "cancel",
		identity: {
			jobId: input.agentId,
			outputLabel: cancellation.outputLabel,
			owner: input.owner,
			processIdentity: input.processIdentity,
		},
		reason: cancellation.reason,
	});
	return {
		message: JSON.stringify({
			body,
			fromAgentId: "main",
			id: messageId,
			kind: "system",
			status: "pending",
			toAgentId: input.agentId,
		}),
		messageId,
	};
}

function canPersistLifecycleTransition(current: unknown, requested: string): boolean {
	if (typeof current !== "string") return false;
	const transitions: Record<string, readonly string[]> = {
		running: ["waiting_for_input", "steering_pending", "cancelling", "completed", "failed", "aborted"],
		waiting_for_input: ["running", "steering_pending", "cancelling", "completed", "aborted"],
		steering_pending: ["running", "cancelling", "failed", "aborted"],
		cancelling: ["aborted", "failed"],
		completed: [],
		failed: [],
		aborted: [],
	};
	return current === requested
		? !["completed", "failed", "aborted"].includes(current)
		: transitions[current]?.includes(requested) === true;
}

export function commitMultiAgentTerminalMutation(
	controlDbPath: string,
	input: CommitMultiAgentTerminalMutationInput,
): CommitMultiAgentTerminalMutationResult {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const agentRow = db
				.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(input.sessionPath, input.agentId) as { data: string } | undefined;
			if (!agentRow) return { ok: false, error: "agent_not_found" };
			const agent = parseStoredJsonObject(agentRow.data, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
			const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
			if (!runtimeOwnershipMatchesTerminalMutation(ownership, input))
				return { ok: false, error: "mutation_mismatch" };
			if (agent.lifecycle === input.terminalLifecycle) {
				return terminalMutationReplayResult(db, input, agent, Number(agent.revision));
			}
			const terminalRevision = Number(agent.revision) + 1;
			if (!canPersistTerminalTransition(agent.lifecycle, input.terminalLifecycle)) {
				return { ok: false, error: "invalid_transition" };
			}
			if (hasActivePersistedDescendant(db, input.sessionPath, input.agentId)) {
				return { ok: false, error: "invalid_transition" };
			}

			const updatedAgent = {
				...agent,
				...input.agentDetails,
				lifecycle: input.terminalLifecycle,
				revision: terminalRevision,
				updatedAt: input.updatedAt,
			};
			db.prepare(
				"UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?",
			).run(JSON.stringify(updatedAgent), input.updatedAt, input.sessionPath, input.agentId);
			db.prepare(
				`INSERT INTO multi_agent_terminal_outbox (
					session_path, agent_id, terminal_revision, event_kind, status,
					claim_id, claimed_at, delivered_at, attempt_count, last_error, updated_at
				) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, 0, NULL, ?)`,
			).run(input.sessionPath, input.agentId, terminalRevision, input.eventKind, input.updatedAt);
			return { ok: true, terminalRevision };
		}),
	);
}

function hasActivePersistedDescendant(db: SqliteDatabase, sessionPath: string, ancestorId: string): boolean {
	const rows = db
		.prepare("SELECT agent_id, data FROM multi_agent_agents WHERE session_path = ?")
		.all(sessionPath) as Array<{ agent_id: string; data: string }>;
	const agents = new Map(
		rows.map((row) => [
			row.agent_id,
			parseStoredJsonObject(row.data, `multi_agent_agents:${sessionPath}#${row.agent_id}`),
		]),
	);
	for (const [agentId, agent] of agents) {
		if (!isNonterminalLifecycle(agent.lifecycle)) continue;
		let parentId = typeof agent.parentId === "string" ? agent.parentId : undefined;
		const visited = new Set<string>([agentId]);
		while (parentId && !visited.has(parentId)) {
			if (parentId === ancestorId) return true;
			visited.add(parentId);
			const parent = agents.get(parentId);
			parentId = typeof parent?.parentId === "string" ? parent.parentId : undefined;
		}
	}
	return false;
}

function isNonterminalLifecycle(lifecycle: unknown): boolean {
	return typeof lifecycle === "string" && !["completed", "failed", "aborted"].includes(lifecycle);
}

function terminalMutationReplayResult(
	db: SqliteDatabase,
	input: CommitMultiAgentTerminalMutationInput,
	agent: Record<string, unknown>,
	terminalRevision: number,
): CommitMultiAgentTerminalMutationResult {
	for (const [key, value] of Object.entries(input.agentDetails ?? {})) {
		if (JSON.stringify(agent[key]) !== JSON.stringify(value)) return { ok: false, error: "mutation_mismatch" };
	}
	const outbox = db
		.prepare(
			`SELECT 1 FROM multi_agent_terminal_outbox
			 WHERE session_path = ? AND agent_id = ? AND terminal_revision = ? AND event_kind = ?`,
		)
		.get(input.sessionPath, input.agentId, terminalRevision, input.eventKind);
	if (!outbox) return { ok: false, error: "mutation_mismatch" };
	return { ok: true, terminalRevision };
}

function canPersistTerminalTransition(
	current: unknown,
	requested: CommitMultiAgentTerminalMutationInput["terminalLifecycle"],
): boolean {
	if (typeof current !== "string") return false;
	const allowedFrom =
		requested === "completed"
			? new Set(["running", "waiting_for_input"])
			: new Set(["running", "waiting_for_input", "steering_pending", "cancelling"]);
	return allowedFrom.has(current);
}

function runtimeOwnershipMatchesTerminalMutation(
	ownership: MultiAgentRuntimeOwnershipRow | undefined,
	input: CommitMultiAgentTerminalMutationInput,
): boolean {
	return runtimeOwnerMatches(ownership, input);
}

export function finalizeDetachedJob(controlDbPath: string, input: FinalizeDetachedJobInput): FinalizeDetachedJobResult {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => finalizeDetachedJobTransaction(db, input.sessionPath, input.terminal)),
	);
}

function finalizeDetachedJobTransaction(
	db: SqliteDatabase,
	sessionPath: string,
	terminal: DetachedJobTerminalInput,
): FinalizeDetachedJobResult {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, terminal.jobId) as { data: string } | undefined;
	if (!row) return { ok: false, error: "agent_not_found" };
	const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${sessionPath}#${terminal.jobId}`);
	const persistedLifecycle = typeof agent.lifecycle === "string" ? agent.lifecycle : undefined;
	const terminalLifecycle =
		persistedLifecycle === "completed" || persistedLifecycle === "failed" || persistedLifecycle === "aborted"
			? persistedLifecycle
			: persistedLifecycle === "cancelling"
				? "aborted"
				: terminal.outcome.kind;
	const eventKind = `detached_job_${terminalLifecycle}`;
	const ownership = readMultiAgentRuntimeOwnershipRow(db, sessionPath, terminal.jobId);
	if (
		!ownership ||
		!runtimeOwnerMatches(ownership, {
			agentId: terminal.jobId,
			owner: terminal.owner,
			processIdentity: terminal.processIdentity,
			sessionPath,
		})
	) {
		return { ok: false, error: "mutation_mismatch" };
	}
	if (agent.lifecycle === terminalLifecycle) {
		return detachedJobReplayResult(db, sessionPath, terminal, agent, Number(agent.revision), eventKind);
	}
	const terminalRevision = Number(agent.revision) + 1;
	const canFinalize = agent.lifecycle === "running" || agent.lifecycle === "cancelling";
	if (!canFinalize || hasActivePersistedDescendant(db, sessionPath, terminal.jobId)) {
		return { ok: false, error: "invalid_transition" };
	}
	const terminalAgent = persistDetachedJobTerminal(
		db,
		sessionPath,
		terminal,
		agent,
		ownership,
		terminalLifecycle,
		terminalRevision,
		eventKind,
	);
	return { ok: true, terminalAgent, terminalRevision };
}

function detachedJobReplayResult(
	db: SqliteDatabase,
	sessionPath: string,
	terminal: DetachedJobTerminalInput,
	terminalAgent: Record<string, unknown>,
	terminalRevision: number,
	eventKind: string,
): FinalizeDetachedJobResult {
	const expectedDetails = detachedJobAgentDetails(
		terminal,
		terminalAgent.lifecycle as "completed" | "failed" | "aborted",
	);
	for (const [key, value] of Object.entries(expectedDetails)) {
		if (JSON.stringify(terminalAgent[key]) !== JSON.stringify(value))
			return { ok: false, error: "mutation_mismatch" };
	}
	const outbox = db
		.prepare(
			`SELECT 1 FROM multi_agent_terminal_outbox
			 WHERE session_path = ? AND agent_id = ? AND terminal_revision = ? AND event_kind = ?`,
		)
		.get(sessionPath, terminal.jobId, terminalRevision, eventKind);
	if (!outbox) return { ok: false, error: "mutation_mismatch" };
	validatePersistedAgentPayload(terminalAgent, `multi_agent_agents:${sessionPath}#${terminal.jobId}`);
	return { ok: true, terminalAgent: terminalAgent as unknown as AgentSnapshot, terminalRevision };
}

function persistDetachedJobTerminal(
	db: SqliteDatabase,
	sessionPath: string,
	terminal: DetachedJobTerminalInput,
	agent: Record<string, unknown>,
	ownership: MultiAgentRuntimeOwnershipRow,
	terminalLifecycle: "completed" | "failed" | "aborted",
	terminalRevision: number,
	eventKind: string,
): AgentSnapshot {
	const updated = {
		...agent,
		...detachedJobAgentDetails(terminal, terminalLifecycle),
		lifecycle: terminalLifecycle,
		revision: terminalRevision,
		updatedAt: terminal.terminalAt,
		worker: undefined,
	};
	db.prepare("UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?").run(
		JSON.stringify(updated),
		terminal.terminalAt,
		sessionPath,
		terminal.jobId,
	);
	db.prepare(
		`INSERT INTO multi_agent_terminal_outbox
			(session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at)
		 VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
	).run(sessionPath, terminal.jobId, terminalRevision, eventKind, terminal.terminalAt);
	persistDetachedJobTerminalTransport(db, sessionPath, terminal, ownership, terminalRevision, eventKind);
	validatePersistedAgentPayload(updated, `multi_agent_agents:${sessionPath}#${terminal.jobId}`);
	return updated as unknown as AgentSnapshot;
}

function persistDetachedJobTerminalTransport(
	db: SqliteDatabase,
	sessionPath: string,
	terminal: DetachedJobTerminalInput,
	ownership: MultiAgentRuntimeOwnershipRow,
	terminalRevision: number,
	eventKind: string,
): void {
	const ownerSessionId = ownership.owner_session_id;
	if (!ownerSessionId) throw new Error(`Detached job ${terminal.jobId} ownership has no owner session`);
	const messageId = `terminal:${terminal.jobId}:${terminalRevision}:${eventKind}`;
	const body = JSON.stringify({ agentId: terminal.jobId, eventKind, terminalRevision, type: "multi_agent_terminal" });
	persistStoredRuntimeMailboxMessage(db, {
		kind: "system",
		message: {
			body,
			createdAt: terminal.terminalAt,
			fromAgentId: terminal.jobId,
			id: messageId,
			kind: "system",
			status: "pending",
			toAgentId: ownership.owner_agent_id ?? "main",
			updatedAt: terminal.terminalAt,
		},
		recipient: { agentId: ownership.owner_agent_id, sessionId: ownerSessionId },
		sender: { agentId: terminal.jobId, sessionId: ownerSessionId },
		storeRef: { messageId, sessionPath },
		updatedAt: terminal.terminalAt,
	});
}

function detachedJobAgentDetails(
	terminal: DetachedJobTerminalInput,
	terminalLifecycle: "completed" | "failed" | "aborted",
): Record<string, unknown> {
	const fileRefs = [{ label: terminal.output.label, path: terminal.output.path }];
	if (terminalLifecycle === "aborted") return { result: { fileRefs } };
	if (terminal.outcome.kind === "completed") {
		return { result: { fileRefs, summary: terminal.outcome.summary } };
	}
	if (terminal.outcome.kind === "failed") {
		return { error: terminal.outcome.error, result: { fileRefs, summary: terminal.outcome.error.message } };
	}
	return { result: { fileRefs } };
}

export function recoverDeadMultiAgentRuntime(
	controlDbPath: string,
	input: RecoverDeadMultiAgentRuntimeInput,
): RecoverDeadMultiAgentRuntimeResult {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const { agentId, sessionPath } = input.expectedOwner;
			if (!registeredSupervisorOwnsSession(db, sessionPath, input.supervisor)) {
				return { ok: false, error: "mutation_mismatch" };
			}
			const row = db
				.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(sessionPath, agentId) as { data: string } | undefined;
			if (!row) return { ok: false, error: "agent_not_found" };
			const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${sessionPath}#${agentId}`);
			if (!isRecoverableRuntimeLifecycle(agent.lifecycle)) {
				return { ok: false, error: "invalid_transition" };
			}
			const owner = readMultiAgentRuntimeOwnershipRow(db, sessionPath, agentId);
			if (!runtimeOwnerMatches(owner, input.expectedOwner)) {
				return { ok: false, error: "mutation_mismatch" };
			}
			if (isProcessIdentityAlive(input.expectedOwner.processIdentity)) return { ok: false, error: "owner_alive" };
			const released = db
				.prepare(
					`UPDATE multi_agent_runtime_owners
					 SET process_identity = NULL, owner_session_id = NULL, owner_agent_id = NULL
					 WHERE session_path = ? AND agent_id = ? AND process_identity = ?
					 AND owner_session_id = ? AND owner_agent_id IS ?`,
				)
				.run(
					sessionPath,
					agentId,
					serializeProcessIdentity(input.expectedOwner.processIdentity),
					input.expectedOwner.owner.sessionId,
					input.expectedOwner.owner.agentId,
				);
			if (released.changes !== 1) return { ok: false, error: "mutation_mismatch" };
			const terminalRevision = Number(agent.revision) + 1;
			const error = { code: "lost_runtime", message: "Agent owner process exited before terminal confirmation." };
			const updated = {
				...agent,
				error,
				lifecycle: "failed",
				revision: terminalRevision,
				updatedAt: input.nowIso,
				worker: undefined,
			};
			db.prepare(
				"UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?",
			).run(JSON.stringify(updated), input.nowIso, sessionPath, agentId);
			db.prepare(
				`INSERT INTO multi_agent_terminal_outbox
					(session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at)
				 VALUES (?, ?, ?, 'lost_runtime', 'pending', 0, ?)`,
			).run(sessionPath, agentId, terminalRevision, input.nowIso);
			return { ok: true, agent: updated, terminalRevision };
		}),
	);
}

export function createFailedMultiAgentChild(
	controlDbPath: string,
	input: CreateFailedMultiAgentChildInput,
): CreateFailedMultiAgentChildResult {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const agent = input.agent as AgentSnapshot & Record<string, unknown>;
			validatePersistedAgentPayload(agent, `multi_agent_agents:${input.sessionPath}#${agent.id}`);
			if (agent.lifecycle !== "failed" || agent.revision !== 1) {
				throw new Error("Failed child creation requires failed revision 1");
			}
			const parentId = agent.parentId;
			if (
				!parentId ||
				(parentId !== "main" &&
					!db
						.prepare("SELECT 1 FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
						.get(input.sessionPath, parentId))
			) {
				return { ok: false, error: "parent_not_found" };
			}
			if (
				db
					.prepare("SELECT 1 FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
					.get(input.sessionPath, agent.id)
			) {
				return { ok: false, error: "agent_exists" };
			}
			db.prepare(
				"INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at) VALUES (?, ?, ?, ?)",
			).run(input.sessionPath, agent.id, JSON.stringify(agent), input.nowIso);
			db.prepare(
				`INSERT INTO multi_agent_terminal_outbox (
					session_path, agent_id, terminal_revision, event_kind, status,
					claim_id, claimed_at, delivered_at, attempt_count, last_error, updated_at
				) VALUES (?, ?, 1, 'failed', 'pending', NULL, NULL, NULL, 0, NULL, ?)`,
			).run(input.sessionPath, agent.id, input.nowIso);
			return { ok: true, agent };
		}),
	);
}

export function createMultiAgentChildWithRuntimeOwnership(
	controlDbPath: string,
	input: CreateMultiAgentChildWithRuntimeOwnershipInput,
): CreateMultiAgentChildWithRuntimeOwnershipResult {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const agent = input.agent as Record<string, unknown>;
			validatePersistedAgentPayload(agent, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
			if (agent.id !== input.agentId)
				throw new Error("Child agent payload ID does not match runtime ownership identity");
			if (agent.lifecycle !== "running" || agent.revision !== 1) {
				throw new Error("Child runtime ownership requires running revision 1");
			}
			const parentId = typeof agent.parentId === "string" ? agent.parentId : undefined;
			if (
				!parentId ||
				(parentId !== "main" &&
					!db
						.prepare("SELECT 1 FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
						.get(input.sessionPath, parentId))
			) {
				return { ok: false, error: "parent_not_found" };
			}
			if (
				db
					.prepare("SELECT 1 FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
					.get(input.sessionPath, input.agentId)
			) {
				return { ok: false, error: "agent_exists" };
			}
			db.prepare(
				"INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at) VALUES (?, ?, ?, ?)",
			).run(input.sessionPath, input.agentId, JSON.stringify(input.agent), input.nowIso);
			db.prepare(`INSERT INTO multi_agent_runtime_owners (
			session_path, agent_id, process_identity, owner_session_id, owner_agent_id
		) VALUES (?, ?, ?, ?, ?)`).run(
				input.sessionPath,
				input.agentId,
				serializeProcessIdentity(input.processIdentity),
				input.owner.sessionId,
				input.owner.agentId,
			);
			const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
			if (!ownership)
				throw new Error(`Child runtime ownership did not persist ${input.sessionPath}#${input.agentId}`);
			return { ok: true, agent: input.agent, ownership: multiAgentRuntimeOwnershipFromRow(ownership) };
		}),
	);
}

export function createMultiAgentAttachment(
	controlDbPath: string,
	input: CreateMultiAgentAttachmentInput,
): CreateMultiAgentAttachmentResult {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const agent = input.agent as AgentSnapshot & Record<string, unknown>;
			validatePersistedAgentPayload(agent, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
			if (agent.id !== input.agentId) throw new Error("Attached agent payload ID does not match command identity");
			if (agent.origin !== "attached" || agent.lifecycle !== "waiting_for_input" || agent.revision !== 1) {
				throw new Error("Attached agent creation requires waiting_for_input revision 1");
			}
			if (
				db
					.prepare("SELECT 1 FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
					.get(input.sessionPath, input.agentId)
			) {
				return { ok: false, error: "agent_exists" };
			}
			if (agent.parentId && agent.parentId !== "main") {
				const parentRow = db
					.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
					.get(input.sessionPath, agent.parentId) as { data: string } | undefined;
				if (!parentRow) return { ok: false, error: "parent_not_found" };
				const parent = parseStoredJsonObject(
					parentRow.data,
					`multi_agent_agents:${input.sessionPath}#${agent.parentId}`,
				);
				validatePersistedAgentPayload(parent, `multi_agent_agents:${input.sessionPath}#${agent.parentId}`);
				const parentPermission = parent.permission as AgentSnapshot["permission"];
				if (!agent.permission.narrowed || agent.permission.policy !== parentPermission.policy) {
					return { ok: false, error: "permission_broadened" };
				}
			}
			db.prepare(
				"INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at) VALUES (?, ?, ?, ?)",
			).run(input.sessionPath, input.agentId, JSON.stringify(agent), input.nowIso);
			return { ok: true, agent: input.agent };
		}),
	);
}

export function readMultiAgentRuntimeOwnership(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
): MultiAgentRuntimeOwnership | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = readMultiAgentRuntimeOwnershipRow(db, sessionPath, agentId);
		return row ? multiAgentRuntimeOwnershipFromRow(row) : undefined;
	});
}

export function acquireAttachedRuntimeOwnership(
	controlDbPath: string,
	input: AcquireAttachedRuntimeOwnershipInput,
): AcquireAttachedRuntimeOwnershipResult {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			if (!registeredSupervisorOwnsSession(db, input.sessionPath, input.supervisor)) {
				return { ok: false, error: "mutation_mismatch" };
			}
			const row = db
				.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(input.sessionPath, input.agentId) as { data: string } | undefined;
			if (!row) return { ok: false, error: "agent_not_found" };
			const context = `multi_agent_agents:${input.sessionPath}#${input.agentId}`;
			const agent = parseStoredJsonObject(row.data, context);
			validatePersistedAgentPayload(agent, context);
			if (!isRecoverableRuntimeLifecycle(agent.lifecycle)) return { ok: false, error: "invalid_agent" };
			const current = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
			if (current?.process_identity) {
				const currentIdentity = parseProcessIdentity(current.process_identity);
				if (isProcessIdentityAlive(currentIdentity)) {
					if (!runtimeOwnerMatches(current, input)) return { ok: false, error: "ownership_held" };
					return {
						agent: agent as unknown as AgentSnapshot,
						ok: true,
						ownership: multiAgentRuntimeOwnershipFromRow(current),
					};
				}
			}
			persistAcquiredRuntimeOwnership(db, input);
			const updatedAgent = { ...agent, revision: Number(agent.revision) + 1, updatedAt: input.nowIso };
			db.prepare(
				"UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?",
			).run(JSON.stringify(updatedAgent), input.nowIso, input.sessionPath, input.agentId);
			const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
			if (!ownership)
				throw new Error(`Attached runtime ownership did not persist ${input.sessionPath}#${input.agentId}`);
			return {
				agent: updatedAgent as unknown as AgentSnapshot,
				ok: true,
				ownership: multiAgentRuntimeOwnershipFromRow(ownership),
			};
		}),
	);
}

function registeredSupervisorOwnsSession(
	db: SqliteDatabase,
	sessionPath: string,
	supervisor: SupervisorRuntimeOwnership,
): boolean {
	if (!isProcessIdentityAlive(supervisor.processIdentity)) return false;
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM runtime_mailbox_listeners
				 WHERE recipient_session_id = ? AND recipient_agent_id_key = ''
				 AND pid = ? AND runtime_instance_id = ?
				 AND session_path = ? AND session_path_asserted_at IS NOT NULL`,
			)
			.get(
				supervisor.sessionId,
				supervisor.processIdentity.pid,
				serializeProcessIdentity(supervisor.processIdentity),
				sessionPath,
			),
	);
}

function isRecoverableRuntimeLifecycle(value: unknown): boolean {
	return (
		value === "waiting_for_input" || value === "running" || value === "steering_pending" || value === "cancelling"
	);
}

function persistAcquiredRuntimeOwnership(db: SqliteDatabase, input: MultiAgentRuntimeOwnershipIdentity): void {
	db.prepare(
		`INSERT INTO multi_agent_runtime_owners (
			session_path, agent_id, process_identity, owner_session_id, owner_agent_id
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(session_path, agent_id) DO UPDATE SET
			process_identity = excluded.process_identity,
			owner_session_id = excluded.owner_session_id,
			owner_agent_id = excluded.owner_agent_id`,
	).run(
		input.sessionPath,
		input.agentId,
		serializeProcessIdentity(input.processIdentity),
		input.owner.sessionId,
		input.owner.agentId,
	);
}

export function acquireMultiAgentRuntimeOwnership(
	controlDbPath: string,
	input: AcquireMultiAgentRuntimeOwnershipInput,
): AcquireMultiAgentRuntimeOwnershipResult {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const currentRow = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
			if (currentRow?.process_identity) {
				const currentIdentity = parseProcessIdentity(currentRow.process_identity);
				if (isProcessIdentityAlive(currentIdentity)) {
					return { ok: false, error: "ownership_held", current: multiAgentRuntimeOwnershipFromRow(currentRow) };
				}
			}
			persistAcquiredRuntimeOwnership(db, input);
			const acquired = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
			if (!acquired)
				throw new Error(`Runtime ownership acquisition did not persist ${input.sessionPath}#${input.agentId}`);
			return { ok: true, ownership: multiAgentRuntimeOwnershipFromRow(acquired) };
		}),
	);
}

export function releaseMultiAgentRuntimeOwnership(
	controlDbPath: string,
	input: ReleaseMultiAgentRuntimeOwnershipInput,
): boolean {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const result = db
				.prepare(
					`UPDATE multi_agent_runtime_owners
					 SET process_identity = NULL, owner_session_id = NULL, owner_agent_id = NULL
					 WHERE session_path = ? AND agent_id = ?
					 AND process_identity = ? AND owner_session_id = ? AND owner_agent_id IS ?`,
				)
				.run(
					input.sessionPath,
					input.agentId,
					serializeProcessIdentity(input.processIdentity),
					input.owner.sessionId,
					input.owner.agentId,
				);
			return result.changes === 1;
		}),
	);
}

function readMultiAgentRuntimeOwnershipRow(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
): MultiAgentRuntimeOwnershipRow | undefined {
	return db
		.prepare("SELECT * FROM multi_agent_runtime_owners WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, agentId) as MultiAgentRuntimeOwnershipRow | undefined;
}

function serializeProcessIdentity(identity: ProcessIdentity): string {
	return JSON.stringify(identity);
}

function parseProcessIdentity(value: string): ProcessIdentity {
	const parsed = JSON.parse(value) as Partial<ProcessIdentity>;
	if (!Number.isSafeInteger(parsed.pid) || !Number.isSafeInteger(parsed.startTimeTicks)) {
		throw new Error("Persisted process identity is invalid");
	}
	return { pid: parsed.pid, startTimeTicks: parsed.startTimeTicks } as ProcessIdentity;
}

function multiAgentRuntimeOwnershipFromRow(row: MultiAgentRuntimeOwnershipRow): MultiAgentRuntimeOwnership {
	return {
		agentId: row.agent_id,
		owner: { agentId: row.owner_agent_id, sessionId: row.owner_session_id ?? undefined },
		processIdentity: row.process_identity ? parseProcessIdentity(row.process_identity) : undefined,
		sessionPath: row.session_path,
	};
}

export function updateMultiAgentAgentActivity(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	lastActivity: AgentSnapshot["lastActivity"],
	updatedAt: string,
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(controlDbPath, sessionPath, agentId, { lastActivity }, updatedAt);
}

export function updateMultiAgentAgentSlot(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	slot: AgentSnapshot["slot"],
	updatedAt: string,
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(controlDbPath, sessionPath, agentId, { slot }, updatedAt);
}

export function updateMultiAgentAgentTranscript(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	transcript: AgentSnapshot["transcript"],
	updatedAt: string,
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(controlDbPath, sessionPath, agentId, { transcript }, updatedAt);
}

function updateMultiAgentAgentMetadata(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	metadata: Pick<AgentSnapshot, "lastActivity"> | Pick<AgentSnapshot, "slot"> | Pick<AgentSnapshot, "transcript">,
	updatedAt: string,
): AgentSnapshot | undefined {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const row = db
				.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(sessionPath, agentId) as { data: string } | undefined;
			if (!row) return undefined;
			const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${sessionPath}#${agentId}`);
			validatePersistedAgentPayload(agent, `multi_agent_agents:${sessionPath}#${agentId}`);
			const updated = { ...agent, ...metadata, updatedAt } as AgentSnapshot;
			db.prepare(
				"UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?",
			).run(JSON.stringify(updated), updatedAt, sessionPath, agentId);
			return updated;
		}),
	);
}

export function bootstrapMultiAgentAgent(controlDbPath: string, sessionPath: string, id: string, data: unknown): void {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`Invalid persisted agent payload at multi_agent_agents:${sessionPath}#${id}`);
	}
	validatePersistedAgentPayload(data as Record<string, unknown>, `multi_agent_agents:${sessionPath}#${id}`);
	withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			if (readMultiAgentRuntimeOwnershipRow(db, sessionPath, id)) {
				throw new Error(`Generic agent upsert cannot mutate process-owned lifecycle row ${sessionPath}#${id}`);
			}
			db.prepare(
				`INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(session_path, agent_id) DO UPDATE SET
				 data = excluded.data, updated_at = excluded.updated_at`,
			).run(sessionPath, id, JSON.stringify(data), new Date().toISOString());
		}),
	);
}

interface PersistedAgentRow {
	session_path: string;
	agent_id: string;
	data: string;
}

export function upsertMultiAgentMailboxMessage(
	controlDbPath: string,
	sessionPath: string,
	id: string,
	data: unknown,
): void {
	validateMailboxPayload(data, `multi_agent_mailbox_messages:${sessionPath}#${id}`);
	withControlDb(controlDbPath, (db) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const serialized = JSON.stringify(data);
			const existing = db
				.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
				.get(sessionPath, id) as { data: string } | undefined;
			if (existing) {
				const previous = parseJsonObject(existing.data);
				const next = parseJsonObject(serialized);
				if (!previous || !next || !sameMailboxMessageIdentity(previous, next, id)) {
					throw new Error(`Mailbox message ID collision: ${sessionPath}#${id}`);
				}
			}
			db.prepare(
				`
				INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(session_path, message_id) DO UPDATE SET
					data = excluded.data,
					updated_at = excluded.updated_at
				`,
			).run(sessionPath, id, serialized, new Date().toISOString());
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

function sameMailboxMessageIdentity(
	previous: Record<string, unknown>,
	next: Record<string, unknown>,
	id: string,
): boolean {
	const requiredIdentity = [previous, next].every(
		(message) =>
			typeof message.id === "string" &&
			typeof message.fromAgentId === "string" &&
			typeof message.toAgentId === "string" &&
			typeof message.kind === "string",
	);
	if (!requiredIdentity) return false;

	return (
		previous.id === id &&
		next.id === id &&
		previous.fromAgentId === next.fromAgentId &&
		previous.toAgentId === next.toAgentId &&
		previous.kind === next.kind &&
		previous.threadId === next.threadId
	);
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
	return updateMultiAgentMailboxMessageStatus(controlDbPath, sessionPath, messageId, "delivered");
}

export function markMultiAgentMailboxMessageFailed(
	controlDbPath: string,
	sessionPath: string,
	messageId: string,
	error: string,
): boolean {
	return updateMultiAgentMailboxMessageStatus(controlDbPath, sessionPath, messageId, "failed", error);
}

function updateMultiAgentMailboxMessageStatus(
	controlDbPath: string,
	sessionPath: string,
	messageId: string,
	status: "delivered" | "failed",
	error?: string,
): boolean {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
			.get(sessionPath, messageId) as { data: string } | undefined;
		if (!row) return false;
		const parsed = parseJsonObject(row.data);
		if (!parsed || parsed.status !== "pending") return false;
		const now = new Date().toISOString();
		const updated = { ...parsed, status, updatedAt: now, ...(error === undefined ? {} : { error }) };
		db.prepare(
			`UPDATE multi_agent_mailbox_messages
			 SET data = ?, updated_at = ?
			 WHERE session_path = ? AND message_id = ?`,
		).run(JSON.stringify(updated), now, sessionPath, messageId);
		return true;
	});
}

function validateMailboxPayload(data: unknown, context: string): void {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`Invalid persisted mailbox payload at ${context}`);
	}
	const payload = data as Record<string, unknown>;
	if (Object.keys(payload).length === 0) {
		throw new Error(`Invalid persisted mailbox payload at ${context}: expected fields`);
	}
	rejectLegacyArtifactFields(data, context);
	for (const field of ["id", "fromAgentId", "toAgentId", "kind", "status", "createdAt", "updatedAt"] as const) {
		if (payload[field] !== undefined) {
			requireStringField(payload, field, context);
		}
	}
	if (payload.body !== undefined) {
		requireStringField(payload, "body", context);
	}
	parseFileRefs(payload.fileRefs, context);
	parseSteeringCheckpoint(payload.targetCheckpoint, context);
}

function validatePersistedAgentPayload(data: Record<string, unknown>, context: string): void {
	if (Object.keys(data).length === 0) {
		throw new Error(`Invalid persisted agent payload at ${context}: expected fields`);
	}
	rejectLegacyArtifactFields(data, context);
	if (
		data.revision !== undefined &&
		(typeof data.revision !== "number" || !Number.isInteger(data.revision) || data.revision < 0)
	) {
		throw new Error(`Invalid persisted revision at ${context}: expected a non-negative integer`);
	}
	if (data.permission !== undefined) {
		if (!data.permission || typeof data.permission !== "object" || Array.isArray(data.permission)) {
			throw new Error(`Invalid persisted permission at ${context}`);
		}
		const permission = data.permission as Record<string, unknown>;
		requireStringField(permission, "policy", `${context}.permission`);
		if (typeof permission.narrowed !== "boolean") {
			throw new Error(`Invalid persisted narrowed at ${context}.permission: expected a boolean`);
		}
	}
	const result = data.result;
	if (result !== undefined) {
		if (!result || typeof result !== "object" || Array.isArray(result)) {
			throw new Error(`Invalid persisted agent result at ${context}`);
		}
		parseFileRefs((result as Record<string, unknown>).fileRefs, `${context}.result`);
	}
}

function rejectLegacyArtifactFields(value: unknown, context: string): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			rejectLegacyArtifactFields(item, `${context}[${index}]`);
		}
		return;
	}
	if (!value || typeof value !== "object") {
		return;
	}
	for (const [key, nested] of Object.entries(value)) {
		if (key === "artifactIds" || key === "artifactRefs") {
			throw new Error(`Legacy artifact fields are not supported at ${context}.${key}`);
		}
		rejectLegacyArtifactFields(nested, `${context}.${key}`);
	}
}

function parseStoredJsonObject(value: string, context: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch (error) {
		throw new Error(`Invalid persisted JSON at ${context}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid persisted object at ${context}`);
	}
	return parsed as Record<string, unknown>;
}

function requireStringField(data: Record<string, unknown>, field: string, context: string): string {
	if (typeof data[field] !== "string") {
		throw new Error(`Invalid persisted ${field} at ${context}: expected a string`);
	}
	return data[field];
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
			INSERT INTO multi_agent_counters_v2 (
				session_path, next_agent_number, next_message_number, updated_at
			)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(session_path) DO UPDATE SET
				next_agent_number = excluded.next_agent_number,
				next_message_number = excluded.next_message_number,
				updated_at = excluded.updated_at
			`,
		).run(sessionPath, counters.nextAgentNumber, counters.nextMessageNumber, new Date().toISOString());
	});
}

export type MultiAgentCounterName = "agent" | "message";

type MultiAgentCounterRow = {
	next_agent_number: number;
	next_message_number: number;
};

const MULTI_AGENT_COUNTER_COLUMNS: Record<MultiAgentCounterName, keyof MultiAgentCounterRow> = {
	agent: "next_agent_number",
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
					SELECT next_agent_number, next_message_number
					FROM multi_agent_counters_v2 WHERE session_path = ?
					`,
				)
				.get(sessionPath) as MultiAgentCounterRow | undefined;
			const counters = {
				next_agent_number: row?.next_agent_number ?? 1,
				next_message_number: row?.next_message_number ?? 1,
			};
			const allocated = counters[column];
			counters[column] = allocated + 1;
			db.prepare(
				`
				INSERT INTO multi_agent_counters_v2 (
					session_path, next_agent_number, next_message_number, updated_at
				)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(session_path) DO UPDATE SET
					next_agent_number = excluded.next_agent_number,
					next_message_number = excluded.next_message_number,
					updated_at = excluded.updated_at
				`,
			).run(sessionPath, counters.next_agent_number, counters.next_message_number, now);
			db.exec("COMMIT");
			return allocated;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

export function readMultiAgentAgent(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
): AgentSnapshot | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
			.get(sessionPath, agentId) as { data: string } | undefined;
		if (!row) return undefined;
		const context = `multi_agent_agents:${sessionPath}#${agentId}`;
		const agent = parseStoredJsonObject(row.data, context);
		validatePersistedAgentPayload(agent, context);
		return agent as unknown as AgentSnapshot;
	});
}

export function readMultiAgentState(controlDbPath: string, sessionPath: string): MultiAgentPersistedState | undefined {
	return withControlDb(controlDbPath, (db) => {
		const readRows = (table: "multi_agent_agents" | "multi_agent_mailbox_messages"): unknown[] =>
			(
				db.prepare(`SELECT data FROM ${table} WHERE session_path = ? ORDER BY rowid`).all(sessionPath) as Array<{
					data: string;
				}>
			).map((row, index) => {
				const context = `${table}:${sessionPath}[${index}]`;
				const data = parseStoredJsonObject(row.data, context);
				if (table === "multi_agent_agents") {
					validatePersistedAgentPayload(data, context);
				} else {
					validateMailboxPayload(data, context);
				}
				return data;
			});
		const counters = db
			.prepare(
				`
				SELECT next_agent_number, next_message_number
				FROM multi_agent_counters_v2 WHERE session_path = ?
				`,
			)
			.get(sessionPath) as { next_agent_number: number; next_message_number: number } | undefined;
		const agents = readRows("multi_agent_agents");
		const mailboxMessages = readRows("multi_agent_mailbox_messages");
		if (!counters && agents.length === 0 && mailboxMessages.length === 0) {
			return undefined;
		}
		return {
			agents,
			mailboxMessages,
			counters: {
				nextAgentNumber: counters?.next_agent_number ?? 1,
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
	assertSupportedControlDbSchemaVersion(db);
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
			runtime_instance_id TEXT,
			session_path TEXT,
			session_path_asserted_at TEXT,
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
			archived_at TEXT,
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

		CREATE TABLE IF NOT EXISTS multi_agent_runtime_owners (
			session_path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			process_identity TEXT,
			owner_session_id TEXT,
			owner_agent_id TEXT,
			PRIMARY KEY (session_path, agent_id)
		);

		CREATE TABLE IF NOT EXISTS multi_agent_terminal_outbox (
			session_path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			terminal_revision INTEGER NOT NULL,
			event_kind TEXT NOT NULL,
			status TEXT NOT NULL,
			claim_id TEXT,
			claimed_at TEXT,
			delivered_at TEXT,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_path, agent_id, terminal_revision, event_kind)
		);

		CREATE INDEX IF NOT EXISTS multi_agent_terminal_outbox_status_idx
		ON multi_agent_terminal_outbox(status, updated_at);

		CREATE TABLE IF NOT EXISTS multi_agent_mailbox_messages (
			session_path TEXT NOT NULL,
			message_id TEXT NOT NULL,
			data TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_path, message_id)
		);

		CREATE TABLE IF NOT EXISTS multi_agent_counters_v2 (
			session_path TEXT PRIMARY KEY,
			next_agent_number INTEGER NOT NULL,
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

		CREATE TABLE IF NOT EXISTS architect_requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sender_session_id TEXT NOT NULL,
			body TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			claimed_at TEXT,
			claim_token TEXT,
			completed_at TEXT
		);

		CREATE INDEX IF NOT EXISTS architect_requests_status_id_idx
		ON architect_requests(status, id);

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
	migrateLegacyMultiAgentCounters(db);
	migrateLegacyMultiAgentPayloads(db);
	addMissingSessionMetadataColumns(db);
	addMissingRuntimeMailboxColumns(db);
	deduplicateRuntimeMailboxStoreReferences(db);
	addMissingRuntimeMailboxListenerColumns(db);
	addMissingArchitectRequestColumns(db);
}

function assertSupportedControlDbSchemaVersion(db: SqliteDatabase): void {
	const schemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (schemaVersion.user_version > CONTROL_DB_SCHEMA_VERSION) {
		throw new Error(
			`Unsupported control database schema version ${schemaVersion.user_version}; this Pi runtime supports up to version ${CONTROL_DB_SCHEMA_VERSION}`,
		);
	}
}

function migrateLegacyMultiAgentCounters(db: SqliteDatabase): void {
	const legacyTable = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'multi_agent_counters'")
		.get();
	if (legacyTable) {
		const legacyRows = db
			.prepare("SELECT session_path, next_agent_number, next_message_number, updated_at FROM multi_agent_counters")
			.all() as Array<{
			session_path: string;
			next_agent_number: number;
			next_message_number: number;
			updated_at: string;
		}>;
		const existing = db.prepare(
			"SELECT next_agent_number, next_message_number, updated_at FROM multi_agent_counters_v2 WHERE session_path = ?",
		);
		const upsert = db.prepare(
			`INSERT INTO multi_agent_counters_v2 (session_path, next_agent_number, next_message_number, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(session_path) DO UPDATE SET
			 next_agent_number = excluded.next_agent_number,
			 next_message_number = excluded.next_message_number,
			 updated_at = excluded.updated_at`,
		);
		for (const row of legacyRows) {
			const current = existing.get(row.session_path) as
				| { next_agent_number: number; next_message_number: number; updated_at: string }
				| undefined;
			upsert.run(
				row.session_path,
				Math.max(current?.next_agent_number ?? 1, row.next_agent_number),
				Math.max(current?.next_message_number ?? 1, row.next_message_number),
				current && current.updated_at > row.updated_at ? current.updated_at : row.updated_at,
			);
		}
		db.exec("DROP TABLE multi_agent_counters");
	}
	db.exec("DROP TABLE IF EXISTS multi_agent_artifacts");
}

function migrateLegacyMultiAgentPayloads(db: SqliteDatabase): void {
	const schemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (schemaVersion.user_version >= CONTROL_DB_SCHEMA_VERSION) return;

	withImmediateTransaction(db, () => {
		const currentSchemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (currentSchemaVersion.user_version >= CONTROL_DB_SCHEMA_VERSION) return;
		assertLifecycleProtocolMigrationQuiescent(db);

		dropLifecycleAccessControlTriggers(db);
		db.exec("DROP TABLE IF EXISTS multi_agent_recovery_leader");
		migrateTerminalOutboxSchema(db);
		migrateRuntimeOwnerTable(db);
		const now = new Date().toISOString();
		migrateLegacyLifecycleRows(db, now);
		migrateLegacyMultiAgentPayloadTable(db, "multi_agent_agents", "agent_id", now);
		migrateLegacyMultiAgentPayloadTable(db, "multi_agent_mailbox_messages", "message_id", now);
		createLegacyArtifactFieldTriggers(db);
		db.exec(`PRAGMA user_version = ${CONTROL_DB_SCHEMA_VERSION}`);
	});
}

function assertLifecycleProtocolMigrationQuiescent(db: SqliteDatabase): void {
	const rows = db
		.prepare(
			`SELECT pid FROM runtime_mailbox_listeners
			 UNION
			 SELECT pid FROM session_health WHERE pid IS NOT NULL`,
		)
		.all() as Array<{ pid: number }>;
	const liveRuntimePids = rows.map((row) => row.pid).filter(isPiRuntimeProcessAlive);
	for (const tableName of ["multi_agent_runtime_owners", "multi_agent_dispatch_leases"] as const) {
		const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
		if (!tableExists) continue;
		const ownerColumns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
		if (!ownerColumns.some((column) => column.name === "process_identity")) continue;
		const owners = db
			.prepare(`SELECT process_identity FROM ${tableName} WHERE process_identity IS NOT NULL`)
			.all() as Array<{ process_identity: string }>;
		for (const owner of owners) {
			try {
				const identity = parseProcessIdentity(owner.process_identity);
				if (isProcessIdentityAlive(identity)) liveRuntimePids.push(identity.pid);
			} catch {
				// Pre-v11 runtime identities did not contain OS process identity.
			}
		}
	}
	const uniqueLivePids = [...new Set(liveRuntimePids)];
	if (uniqueLivePids.length === 0) return;

	throw new Error(
		`Cannot activate lifecycle protocol version ${CONTROL_DB_SCHEMA_VERSION} while lifecycle owners are active (PIDs: ${uniqueLivePids.join(", ")}). Stop all Pi and detached runner processes, then retry`,
	);
}

function migrateTerminalOutboxSchema(db: SqliteDatabase): void {
	const eventTableExists = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'multi_agent_terminal_events'")
		.get();
	if (!eventTableExists) return;
	db.exec(`
		DROP TABLE IF EXISTS multi_agent_terminal_cursors;
		ALTER TABLE multi_agent_terminal_outbox RENAME TO multi_agent_terminal_outbox_v12;
		CREATE TABLE multi_agent_terminal_outbox (
			session_path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			terminal_revision INTEGER NOT NULL,
			event_kind TEXT NOT NULL,
			status TEXT NOT NULL,
			claim_id TEXT,
			claimed_at TEXT,
			delivered_at TEXT,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_path, agent_id, terminal_revision, event_kind)
		);
		INSERT INTO multi_agent_terminal_outbox
		SELECT * FROM multi_agent_terminal_outbox_v12;
		DROP TABLE multi_agent_terminal_outbox_v12;
		DROP TABLE multi_agent_terminal_events;
		CREATE INDEX IF NOT EXISTS multi_agent_terminal_outbox_status_idx
		ON multi_agent_terminal_outbox(status, updated_at);
	`);
}

function migrateRuntimeOwnerTable(db: SqliteDatabase): void {
	const oldTableExists = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'multi_agent_dispatch_leases'")
		.get();
	if (oldTableExists) {
		const oldColumns = db.prepare("PRAGMA table_info(multi_agent_dispatch_leases)").all() as Array<{ name: string }>;
		const hasExactProcessIdentity = oldColumns.some((column) => column.name === "process_identity");
		const copyColumns = hasExactProcessIdentity
			? `session_path, agent_id, process_identity, owner_session_id, owner_agent_id`
			: `session_path, agent_id`;
		db.exec(`
			INSERT OR REPLACE INTO multi_agent_runtime_owners (${copyColumns})
			SELECT ${copyColumns} FROM multi_agent_dispatch_leases;
			DROP TABLE multi_agent_dispatch_leases;
			DROP INDEX IF EXISTS multi_agent_dispatch_leases_expiry_idx;
		`);
	}

	const columns = db.prepare("PRAGMA table_info(multi_agent_runtime_owners)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "lease_id")) return;
	db.exec(`
		ALTER TABLE multi_agent_runtime_owners RENAME TO multi_agent_runtime_owners_legacy;
		CREATE TABLE multi_agent_runtime_owners (
			session_path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			process_identity TEXT,
			owner_session_id TEXT,
			owner_agent_id TEXT,
			PRIMARY KEY (session_path, agent_id)
		);
		INSERT INTO multi_agent_runtime_owners (session_path, agent_id)
		SELECT session_path, agent_id FROM multi_agent_runtime_owners_legacy;
		DROP TABLE multi_agent_runtime_owners_legacy;
		DROP INDEX IF EXISTS multi_agent_runtime_owners_expiry_idx;
	`);
}

function migrateLegacyLifecycleRows(db: SqliteDatabase, nowIso: string): void {
	const rows = db
		.prepare(`SELECT agents.session_path, agents.agent_id, agents.data
		FROM multi_agent_agents AS agents LEFT JOIN multi_agent_runtime_owners AS owners
		ON owners.session_path = agents.session_path AND owners.agent_id = agents.agent_id
		WHERE owners.agent_id IS NULL OR owners.process_identity IS NULL`)
		.all() as PersistedAgentRow[];
	for (const row of rows) {
		const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${row.session_path}#${row.agent_id}`);
		if (agent.lifecycle === "queued") {
			db.prepare(`INSERT OR IGNORE INTO multi_agent_runtime_owners (session_path, agent_id) VALUES (?, ?)`).run(
				row.session_path,
				row.agent_id,
			);
			continue;
		}
		if (
			typeof agent.lifecycle !== "string" ||
			!["starting", "running", "waiting_for_input", "steering_pending", "cancelling"].includes(agent.lifecycle)
		)
			continue;
		const terminalRevision = typeof agent.revision === "number" ? agent.revision + 1 : 1;
		const error = {
			code: "lost_runtime",
			message: "Legacy active agent had no fenced runtime ownership during protocol migration.",
		};
		const updated = {
			...agent,
			error,
			lifecycle: "failed",
			revision: terminalRevision,
			updatedAt: nowIso,
			worker: undefined,
		};
		db.prepare("UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?").run(
			JSON.stringify(updated),
			nowIso,
			row.session_path,
			row.agent_id,
		);
		db.prepare(
			`INSERT INTO multi_agent_terminal_outbox (session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at) VALUES (?, ?, ?, 'lost_runtime', 'pending', 0, ?)`,
		).run(row.session_path, row.agent_id, terminalRevision, nowIso);
	}
}

function dropLifecycleAccessControlTriggers(db: SqliteDatabase): void {
	db.exec(`
		DROP TRIGGER IF EXISTS multi_agent_agents_require_authorized_lifecycle_update;
		DROP TRIGGER IF EXISTS multi_agent_agents_require_lifecycle_protocol_insert;
		DROP TRIGGER IF EXISTS multi_agent_agents_require_lifecycle_protocol_update;
	`);
}

function migrateLegacyMultiAgentPayloadTable(
	db: SqliteDatabase,
	table: "multi_agent_agents" | "multi_agent_mailbox_messages",
	idColumn: "agent_id" | "message_id",
	now: string,
): void {
	const rows = db.prepare(`SELECT session_path, ${idColumn}, data FROM ${table}`).all() as Array<{
		session_path: string;
		data: string;
		[key: string]: string;
	}>;
	const update = db.prepare(`UPDATE ${table} SET data = ?, updated_at = ? WHERE session_path = ? AND ${idColumn} = ?`);
	for (const row of rows) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.data) as unknown;
		} catch {
			// Leave malformed payloads for the normal restore validator to report with row context.
			continue;
		}
		const migrated = stripLegacyArtifactFields(parsed);
		if (!migrated.changed) continue;
		update.run(JSON.stringify(migrated.value), now, row.session_path, row[idColumn]);
	}
}

function createLegacyArtifactFieldTriggers(db: SqliteDatabase): void {
	for (const table of ["multi_agent_agents", "multi_agent_mailbox_messages"] as const) {
		db.exec(`
			CREATE TRIGGER IF NOT EXISTS ${table}_reject_legacy_artifact_fields_insert
			BEFORE INSERT ON ${table}
			FOR EACH ROW
			WHEN json_valid(NEW.data)
				AND EXISTS (
					SELECT 1 FROM json_tree(NEW.data)
					WHERE key IN ('artifactIds', 'artifactRefs')
				)
			BEGIN
				SELECT RAISE(ABORT, 'Legacy artifact fields are not supported');
			END;

			CREATE TRIGGER IF NOT EXISTS ${table}_reject_legacy_artifact_fields_update
			BEFORE UPDATE OF data ON ${table}
			FOR EACH ROW
			WHEN json_valid(NEW.data)
				AND EXISTS (
					SELECT 1 FROM json_tree(NEW.data)
					WHERE key IN ('artifactIds', 'artifactRefs')
				)
			BEGIN
				SELECT RAISE(ABORT, 'Legacy artifact fields are not supported');
			END;
		`);
	}
}

function stripLegacyArtifactFields(value: unknown): { value: unknown; changed: boolean } {
	if (Array.isArray(value)) {
		let changed = false;
		const migrated = value.map((item) => {
			const result = stripLegacyArtifactFields(item);
			changed ||= result.changed;
			return result.value;
		});
		return { value: changed ? migrated : value, changed };
	}
	if (!value || typeof value !== "object") return { value, changed: false };

	let changed = false;
	const migratedEntries: Array<[string, unknown]> = [];
	for (const [key, nested] of Object.entries(value)) {
		if (key === "artifactIds" || key === "artifactRefs") {
			changed = true;
			continue;
		}
		const result = stripLegacyArtifactFields(nested);
		changed ||= result.changed;
		migratedEntries.push([key, result.value]);
	}
	return { value: changed ? Object.fromEntries(migratedEntries) : value, changed };
}

function addMissingArchitectRequestColumns(db: SqliteDatabase): void {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(architect_requests)").all() as TableInfoRow[]).map((column) => column.name),
	);
	if (!columns.has("claimed_at")) db.exec("ALTER TABLE architect_requests ADD COLUMN claimed_at TEXT");
	if (!columns.has("claim_token")) db.exec("ALTER TABLE architect_requests ADD COLUMN claim_token TEXT");
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

function deduplicateRuntimeMailboxStoreReferences(db: SqliteDatabase): void {
	const existingIndex = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'runtime_mailbox_store_ref_unique_idx'")
		.get();
	if (existingIndex) return;

	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec(`
			DELETE FROM runtime_mailbox_messages
			WHERE id IN (
				SELECT id
				FROM (
					SELECT id,
						ROW_NUMBER() OVER (
							PARTITION BY store_session_path, store_message_id
							ORDER BY
								CASE status
									WHEN 'delivered' THEN 4
									WHEN 'claimed' THEN 3
									WHEN 'pending' THEN 2
									ELSE 1
								END DESC,
								updated_at DESC,
								id DESC
						) AS duplicate_rank
					FROM runtime_mailbox_messages
					WHERE store_session_path IS NOT NULL AND store_message_id IS NOT NULL
				)
				WHERE duplicate_rank > 1
			);

			CREATE UNIQUE INDEX IF NOT EXISTS runtime_mailbox_store_ref_unique_idx
			ON runtime_mailbox_messages(store_session_path, store_message_id)
			WHERE store_session_path IS NOT NULL AND store_message_id IS NOT NULL;
		`);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function addMissingRuntimeMailboxListenerColumns(db: SqliteDatabase): void {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(runtime_mailbox_listeners)").all() as TableInfoRow[]).map((column) => column.name),
	);
	if (!columns.has("runtime_instance_id")) {
		db.exec("ALTER TABLE runtime_mailbox_listeners ADD COLUMN runtime_instance_id TEXT");
	}
	if (!columns.has("session_path")) {
		db.exec("ALTER TABLE runtime_mailbox_listeners ADD COLUMN session_path TEXT");
	}
	if (!columns.has("session_path_asserted_at")) {
		db.exec("ALTER TABLE runtime_mailbox_listeners ADD COLUMN session_path_asserted_at TEXT");
	}
}

function addMissingSessionMetadataColumns(db: SqliteDatabase): void {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(session_metadata)").all() as TableInfoRow[]).map((column) => column.name),
	);
	if (!columns.has("archived_at")) {
		db.exec("ALTER TABLE session_metadata ADD COLUMN archived_at TEXT");
	}
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
