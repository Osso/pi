import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { getUserStateRoot } from "../config.ts";
import type { DetachedJobTerminalInput } from "./detached-job-runner.ts";
import {
	type AgentFileReference,
	type AgentMailboxMessage,
	type AgentSnapshot,
	isActiveLifecycle,
} from "./multi-agent-store.ts";
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

const CONTROL_DB_SCHEMA_VERSION = 14;

export interface IncomingControlMessage {
	id: number;
	content: string;
}

export type RuntimeMailboxMessageKind = "message" | "ask" | "reply" | "steer" | "parent_request" | "system";
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
	projectCwd?: string;
	body: string;
	status: ArchitectRequestStatus;
	createdAt: string;
	claimedAt?: string;
	claimToken?: string;
	completedAt?: string;
}

export interface PostArchitectRequestInput {
	senderSessionId: string;
	projectCwd: string;
	body: string;
}

export type SupervisorRequestKind = "approval_review" | "goal_completion_review" | "goal_idle_review";

export type SupervisorRequestStatus = "pending" | "claimed" | "completed";

export type SupervisorResponse =
	| { kind: "approve" | "reject"; reason: string }
	| { kind: "complete"; reason: string }
	| { kind: "continue"; instructions: string; reason: string }
	| { kind: "pause"; reason: string }
	| { kind: "wait"; reason: string }
	| { kind: "error"; reason: string };

export interface SupervisorRequest {
	id: number;
	senderSessionId: string;
	projectId: string;
	kind: SupervisorRequestKind;
	payload: Record<string, unknown>;
	deadlineAt: string;
	status: SupervisorRequestStatus;
	createdAt: string;
	claimedAt?: string;
	claimToken?: string;
	completedAt?: string;
	response?: SupervisorResponse;
}

export interface PostSupervisorRequestInput {
	senderSessionId: string;
	projectId: string;
	kind: SupervisorRequestKind;
	payload: Record<string, unknown>;
	deadlineAt: string;
}

export interface EnqueueStoredRuntimeMailboxMessageInput extends EnqueueRuntimeMailboxMessageInput {
	message: unknown;
	updatedAt?: string;
}

export interface EnqueueRuntimeMailboxMessageInput {
	recipient: RuntimeMailboxAddress;
	sender: RuntimeMailboxAddress;
	kind: RuntimeMailboxMessageKind;
	/** Canonical mailbox row receiving runtime routing and delivery state. */
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

export type WritableSessionMetadata = Omit<SessionMetadata, "goalJson" | "updatedAt">;

type IncomingRow = {
	id: number;
	content: string;
};

type RuntimeMailboxRow = {
	id: number;
	session_path: string;
	message_id: string;
	data: string;
	updated_at: string;
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

const RUNTIME_PROCESS_INSTANCE_ID_KEY = Symbol.for("@earendil-works/pi/runtime-process-instance-id");

export function getRuntimeProcessInstanceId(): string {
	const existing = Reflect.get(globalThis, RUNTIME_PROCESS_INSTANCE_ID_KEY);
	if (typeof existing === "string") return existing;
	const created = JSON.stringify({
		...readProcessIdentity(process.pid),
		incarnation: randomUUID(),
	});
	Reflect.set(globalThis, RUNTIME_PROCESS_INSTANCE_ID_KEY, created);
	return created;
}

const RUNTIME_PROCESS_INSTANCE_ID = getRuntimeProcessInstanceId();

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

export function getControlDbPath(directory = getUserStateRoot()): string {
	return join(directory, "control.sqlite");
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
	const result = withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const row = readCanonicalMailboxRowByStoreRef(db, input.storeRef);
			if (!row) {
				throw new Error(
					`Runtime mailbox store reference does not exist: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`,
				);
			}
			const context = `multi_agent_mailbox_messages:${input.storeRef.sessionPath}#${input.storeRef.messageId}`;
			const message = parseStoredJsonObject(row.data, context);
			validateMailboxPayload(message, context);
			const routed = addRuntimeMailboxRouting(message, input);
			const serialized = JSON.stringify(routed);
			const changed = serialized !== row.data;
			if (changed) {
				const now = new Date().toISOString();
				db.prepare("UPDATE multi_agent_mailbox_messages SET data = ?, updated_at = ? WHERE rowid = ?").run(
					serialized,
					now,
					row.id,
				);
			}
			return {
				id: row.id,
				listener: changed ? readRuntimeMailboxListenerRow(db, input.recipient) : undefined,
			};
		}),
	);
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
	const context = `multi_agent_mailbox_messages:${input.storeRef.sessionPath}#${input.storeRef.messageId}`;
	const incoming = parseStoredJsonObject(JSON.stringify(input.message), context);
	const routed = addRuntimeMailboxRouting(incoming, input);
	const serialized = JSON.stringify(routed);
	const existing = readCanonicalMailboxRowByStoreRef(db, input.storeRef);
	if (existing) {
		const previous = parseStoredJsonObject(existing.data, context);
		if (!sameMailboxMessageIdentity(previous, routed, input.storeRef.messageId)) {
			throw new Error(`Mailbox message ID collision: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`);
		}
		assertRuntimeMailboxRouting(previous, input);
		if (stripRuntimeMailboxDeliveryState(existing.data) !== stripRuntimeMailboxDeliveryState(serialized)) {
			throw new Error(`Mailbox message ID collision: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`);
		}
		return { id: existing.id, listener: undefined };
	}
	const inserted = db
		.prepare(
			`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(input.storeRef.sessionPath, input.storeRef.messageId, serialized, now);
	return {
		id: Number(inserted.lastInsertRowid),
		listener: readRuntimeMailboxListenerRow(db, input.recipient),
	};
}

function persistImmutableMailboxPayload(db: SqliteDatabase, input: EnqueueStoredRuntimeMailboxMessageInput): void {
	persistStoredRuntimeMailboxMessage(db, input);
}

function addRuntimeMailboxRouting(
	message: Record<string, unknown>,
	input: EnqueueRuntimeMailboxMessageInput,
): Record<string, unknown> {
	assertRuntimeMailboxRouting(message, input);
	return {
		...message,
		recipientSessionId: input.recipient.sessionId,
		recipientAgentId: input.recipient.agentId,
		senderSessionId: input.sender.sessionId,
		senderAgentId: input.sender.agentId,
	};
}

function assertRuntimeMailboxRouting(message: Record<string, unknown>, input: EnqueueRuntimeMailboxMessageInput): void {
	const hasRouting = typeof message.recipientSessionId === "string";
	if (!hasRouting) return;
	const sameRecipient =
		message.recipientSessionId === input.recipient.sessionId && message.recipientAgentId === input.recipient.agentId;
	const sameSender =
		message.senderSessionId === input.sender.sessionId && message.senderAgentId === input.sender.agentId;
	if (sameRecipient && sameSender && message.kind === input.kind) return;
	throw new Error(
		`Runtime mailbox store reference conflicts with canonical mailbox row: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`,
	);
}

function stripRuntimeMailboxDeliveryState(serialized: string): string {
	const message = parseStoredJsonObject(serialized, "runtime_mailbox_identity");
	const { claimedAt, claimantProcessIdentity, deliveredAt, error, status, updatedAt, ...identity } = message;
	void claimedAt;
	void claimantProcessIdentity;
	void deliveredAt;
	void error;
	void status;
	void updatedAt;
	return JSON.stringify(identity);
}

export function recoverDeadRuntimeMailboxClaims(controlDbPath: string, recipient: RuntimeMailboxAddress): number {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const rows = readCanonicalMailboxRowsForRecipient(db, recipient, "claimed", Number.MAX_SAFE_INTEGER).filter(
				(row) => canCurrentRuntimeClaimMailboxRow(db, recipient, row),
			);
			let recovered = 0;
			const now = new Date().toISOString();
			for (const row of rows) {
				const message = parseCanonicalMailboxPayload(row);
				const claimant = requireStringField(message, "claimantProcessIdentity", "runtime_mailbox_claim");
				if (canonicalMailboxClaimantIsLive(db, recipient, claimant)) continue;
				const pending: Record<string, unknown> = { ...message, status: "pending", updatedAt: now };
				delete pending.claimedAt;
				delete pending.claimantProcessIdentity;
				if (compareAndWriteCanonicalMailboxPayload(db, row, pending, now)) recovered += 1;
			}
			return recovered;
		}),
	);
}

export function takeRuntimeMailboxMessagesForDelivery(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	isEligible: (message: RuntimeMailboxMessage) => boolean,
	limit = 20,
): RuntimeMailboxMessage[] {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const rows = readCanonicalMailboxRowsForRecipient(db, recipient, "pending", Number.MAX_SAFE_INTEGER).filter(
				(row) => canCurrentRuntimeClaimMailboxRow(db, recipient, row),
			);
			const now = new Date().toISOString();
			const deliveredMessages: RuntimeMailboxMessage[] = [];
			for (const row of rows) {
				const data = parseCanonicalMailboxPayload(row);
				const message = runtimeMailboxMessageFromCanonicalRow(row, data);
				if (!isEligible(message)) continue;
				const delivered = { ...data, status: "delivered", deliveredAt: now, updatedAt: now };
				writeCanonicalMailboxPayload(db, row.id, delivered, now);
				deliveredMessages.push(runtimeMailboxMessageFromCanonicalRow(row, delivered));
				if (deliveredMessages.length === limit) break;
			}
			return deliveredMessages;
		}),
	);
}

export function claimRuntimeMailboxMessages(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	limit = 20,
): RuntimeMailboxMessage[] {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const rows = readCanonicalMailboxRowsForRecipient(db, recipient, "pending", limit).filter((row) =>
				canCurrentRuntimeClaimMailboxRow(db, recipient, row),
			);
			const now = new Date().toISOString();
			const claimed: RuntimeMailboxMessage[] = [];
			for (const row of rows) {
				const message = parseCanonicalMailboxPayload(row);
				message.status = "claimed";
				message.claimedAt = now;
				message.claimantProcessIdentity = RUNTIME_PROCESS_INSTANCE_ID;
				message.updatedAt = now;
				if (compareAndWriteCanonicalMailboxPayload(db, row, message, now)) {
					claimed.push(runtimeMailboxMessageFromCanonicalRow(row, message));
				}
			}
			return claimed;
		}),
	);
}

function canCurrentRuntimeClaimMailboxRow(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	row: RuntimeMailboxRow,
): boolean {
	const listener = readRuntimeMailboxListenerRow(db, recipient);
	if (listener?.pid === process.pid && listener.runtime_instance_id === RUNTIME_PROCESS_INSTANCE_ID) return true;
	if (!recipient.agentId) return false;
	const ownership = readMultiAgentRuntimeOwnershipRow(db, row.session_path, recipient.agentId);
	return persistedProcessIdentityIsCurrent(ownership?.process_identity);
}

function canonicalMailboxClaimantIsLive(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	claimantProcessIdentity: string,
): boolean {
	const listener = readRuntimeMailboxListenerRow(db, recipient);
	if (listener) return listener.runtime_instance_id === claimantProcessIdentity;
	return persistedProcessIdentityIsLive(claimantProcessIdentity);
}

function persistedProcessIdentityIsCurrent(value: string | null | undefined): boolean {
	if (!value) return false;
	try {
		const current = readProcessIdentity(process.pid);
		const persisted = parseProcessIdentity(value);
		return current.pid === persisted.pid && current.startTimeTicks === persisted.startTimeTicks;
	} catch {
		return false;
	}
}

function persistedProcessIdentityIsLive(value: string): boolean {
	try {
		return isProcessIdentityAlive(parseProcessIdentity(value));
	} catch {
		return false;
	}
}

function readCanonicalMailboxRowsForRecipient(
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
			   AND ((? IS NULL AND CASE WHEN json_valid(data) THEN json_extract(data, '$.recipientAgentId') END IS NULL)
			        OR CASE WHEN json_valid(data) THEN json_extract(data, '$.recipientAgentId') END = ?)
			 ORDER BY rowid ASC
			 LIMIT ?`,
		)
		.all(status, recipient.sessionId, recipient.agentId, recipient.agentId, limit) as RuntimeMailboxRow[];
}

function readCanonicalMailboxRowByStoreRef(
	db: SqliteDatabase,
	storeRef: RuntimeMailboxStoreRef,
): RuntimeMailboxRow | undefined {
	return db
		.prepare(
			`SELECT rowid AS id, session_path, message_id, data, updated_at
			 FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?`,
		)
		.get(storeRef.sessionPath, storeRef.messageId) as RuntimeMailboxRow | undefined;
}

function readCanonicalMailboxRowById(db: SqliteDatabase, id: number): RuntimeMailboxRow | undefined {
	return db
		.prepare(
			`SELECT rowid AS id, session_path, message_id, data, updated_at
			 FROM multi_agent_mailbox_messages WHERE rowid = ?`,
		)
		.get(id) as RuntimeMailboxRow | undefined;
}

function parseCanonicalMailboxPayload(row: RuntimeMailboxRow): Record<string, unknown> {
	const context = `multi_agent_mailbox_messages:${row.session_path}#${row.message_id}`;
	const message = parseStoredJsonObject(row.data, context);
	validateMailboxPayload(message, context);
	return message;
}

function writeCanonicalMailboxPayload(
	db: SqliteDatabase,
	id: number,
	message: Record<string, unknown>,
	updatedAt: string,
): void {
	const updated = db
		.prepare("UPDATE multi_agent_mailbox_messages SET data = ?, updated_at = ? WHERE rowid = ?")
		.run(JSON.stringify(message), updatedAt, id);
	if (updated.changes !== 1) throw new Error(`Canonical mailbox mutation lost row ${id}`);
}

function compareAndWriteCanonicalMailboxPayload(
	db: SqliteDatabase,
	row: RuntimeMailboxRow,
	message: Record<string, unknown>,
	updatedAt: string,
): boolean {
	const updated = db
		.prepare(
			`UPDATE multi_agent_mailbox_messages SET data = ?, updated_at = ?
			 WHERE rowid = ? AND session_path = ? AND message_id = ? AND data = ? AND updated_at = ?`,
		)
		.run(JSON.stringify(message), updatedAt, row.id, row.session_path, row.message_id, row.data, row.updated_at);
	return updated.changes === 1;
}

export function readRuntimeMailboxMessageForDelivery(
	controlDbPath: string,
	id: number,
): { message: RuntimeMailboxMessage; payloadData?: string; payloadValid: boolean } | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = readCanonicalMailboxRowById(db, id);
		if (!row) return undefined;
		const message = parseCanonicalMailboxPayload(row);
		return {
			message: runtimeMailboxMessageFromCanonicalRow(row, message),
			payloadData: row.data,
			payloadValid: message.status === "claimed" && message.claimantProcessIdentity === RUNTIME_PROCESS_INSTANCE_ID,
		};
	});
}

export function consumeRuntimeMailboxMessage(controlDbPath: string, id: number): boolean {
	return withControlDb(controlDbPath, (db) => {
		const row = readCanonicalMailboxRowById(db, id);
		if (!row) return false;
		return parseCanonicalMailboxPayload(row).status === "delivered";
	});
}

export function deliverRuntimeMailboxMessage(controlDbPath: string, id: number, expectedPayloadData?: string): boolean {
	return updateClaimedCanonicalMailboxMessage(controlDbPath, id, expectedPayloadData, "delivered");
}

function updateClaimedCanonicalMailboxMessage(
	controlDbPath: string,
	id: number,
	expectedPayloadData: string | undefined,
	status: "delivered" | "failed" | "pending",
	error?: string,
): boolean {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () =>
			updateClaimedCanonicalMailboxMessageInTransaction(db, id, expectedPayloadData, status, error),
		),
	);
}

function updateClaimedCanonicalMailboxMessageInTransaction(
	db: SqliteDatabase,
	id: number,
	expectedPayloadData: string | undefined,
	status: "delivered" | "failed" | "pending",
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
	if (status === "delivered") updated.deliveredAt = now;
	if (status === "failed") updated.error = error;
	return compareAndWriteCanonicalMailboxPayload(db, row, updated, now);
}

export function consumeRuntimeMailboxMessageByStoreRef(
	controlDbPath: string,
	storeRef: RuntimeMailboxStoreRef,
): number {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const row = readCanonicalMailboxRowByStoreRef(db, storeRef);
			if (!row) return 0;
			const message = parseCanonicalMailboxPayload(row);
			if (message.status === "delivered") return 0;
			const now = new Date().toISOString();
			const delivered: Record<string, unknown> = {
				...message,
				status: "delivered",
				deliveredAt: now,
				updatedAt: now,
			};
			delete delivered.claimedAt;
			delete delivered.claimantProcessIdentity;
			return compareAndWriteCanonicalMailboxPayload(db, row, delivered, now) ? 1 : 0;
		}),
	);
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

export function assertMainSessionRuntimeAvailable(controlDbPath: string, sessionId: string): void {
	withControlDb(controlDbPath, (db) => {
		const recipient = { agentId: null, sessionId };
		assertRuntimeReplacementAllowed(
			db,
			sessionId,
			readRuntimeMailboxListenerRow(db, recipient),
			process.pid,
			RUNTIME_PROCESS_INSTANCE_ID,
			{},
		);
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
export function resolveOwnMainRuntimeCoordinationRecipient(controlDbPath: string): RuntimeMailboxAddress | undefined {
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
				INSERT INTO architect_requests (sender_session_id, project_cwd, body, status, created_at)
				VALUES (?, ?, ?, 'pending', ?)
				`,
			)
			.run(input.senderSessionId, input.projectCwd, body, now);
		return Number(result.lastInsertRowid);
	});
}

type ArchitectRequestRow = {
	id: number;
	sender_session_id: string;
	project_cwd: string | null;
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
		projectCwd: row.project_cwd ?? undefined,
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
					`SELECT id, sender_session_id, project_cwd, body, status, created_at, claimed_at, claim_token, completed_at
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
					`SELECT id, sender_session_id, project_cwd, body, status, created_at, claimed_at, claim_token, completed_at
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

type SupervisorRequestRow = {
	id: number;
	sender_session_id: string;
	project_id: string;
	kind: SupervisorRequestKind;
	payload_json: string;
	deadline_at: string;
	status: SupervisorRequestStatus;
	created_at: string;
	claimed_at: string | null;
	claim_token: string | null;
	completed_at: string | null;
	response_json: string | null;
};

function supervisorRequestFromRow(row: SupervisorRequestRow): SupervisorRequest {
	return {
		id: row.id,
		senderSessionId: row.sender_session_id,
		projectId: row.project_id,
		kind: row.kind,
		payload: JSON.parse(row.payload_json) as Record<string, unknown>,
		deadlineAt: row.deadline_at,
		status: row.status,
		createdAt: row.created_at,
		claimedAt: row.claimed_at ?? undefined,
		claimToken: row.claim_token ?? undefined,
		completedAt: row.completed_at ?? undefined,
		response: row.response_json ? (JSON.parse(row.response_json) as SupervisorResponse) : undefined,
	};
}

const SUPERVISOR_REQUEST_COLUMNS = `id, sender_session_id, project_id, kind, payload_json, deadline_at,
	status, created_at, claimed_at, claim_token, completed_at, response_json`;

export function postSupervisorRequest(controlDbPath: string, input: PostSupervisorRequestInput): number {
	return withControlDb(controlDbPath, (db) => {
		const result = db
			.prepare(
				`INSERT INTO supervisor_requests
				 (sender_session_id, project_id, kind, payload_json, deadline_at, status, created_at)
				 VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
			)
			.run(
				input.senderSessionId,
				input.projectId,
				input.kind,
				JSON.stringify(input.payload),
				input.deadlineAt,
				new Date().toISOString(),
			);
		return Number(result.lastInsertRowid);
	});
}

export function readSupervisorRequest(controlDbPath: string, requestId: number): SupervisorRequest | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(`SELECT ${SUPERVISOR_REQUEST_COLUMNS} FROM supervisor_requests WHERE id = ?`)
			.get(requestId) as SupervisorRequestRow | undefined;
		return row ? supervisorRequestFromRow(row) : undefined;
	});
}

export function claimNextSupervisorRequest(controlDbPath: string, claimToken: string): SupervisorRequest | undefined {
	return withControlDb(controlDbPath, (db) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const activeClaim = db.prepare("SELECT 1 FROM supervisor_requests WHERE status = 'claimed' LIMIT 1").get();
			if (activeClaim) {
				db.exec("COMMIT");
				return undefined;
			}
			const row = db
				.prepare(
					`SELECT ${SUPERVISOR_REQUEST_COLUMNS}
					 FROM supervisor_requests
					 WHERE status = 'pending'
					 ORDER BY CASE kind WHEN 'approval_review' THEN 0 ELSE 1 END, id ASC
					 LIMIT 1`,
				)
				.get() as SupervisorRequestRow | undefined;
			if (!row) {
				db.exec("COMMIT");
				return undefined;
			}
			const claimedAt = new Date().toISOString();
			db.prepare(
				"UPDATE supervisor_requests SET status = 'claimed', claimed_at = ?, claim_token = ? WHERE id = ? AND status = 'pending'",
			).run(claimedAt, claimToken, row.id);
			db.exec("COMMIT");
			return supervisorRequestFromRow({
				...row,
				status: "claimed",
				claimed_at: claimedAt,
				claim_token: claimToken,
			});
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

export function recoverSupervisorRequests(controlDbPath: string): void {
	withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		const errorResponse = JSON.stringify({ kind: "error", reason: "Supervisor request deadline expired" });
		db.exec("BEGIN IMMEDIATE");
		try {
			db.prepare(
				`UPDATE supervisor_requests
				 SET status = 'completed', completed_at = ?, response_json = ?, claim_token = NULL
				 WHERE status IN ('pending', 'claimed') AND deadline_at <= ?`,
			).run(now, errorResponse, now);
			db.prepare(
				`UPDATE supervisor_requests
				 SET status = 'pending', claimed_at = NULL, claim_token = NULL
				 WHERE status = 'claimed'`,
			).run();
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

export function hasPendingSupervisorApprovalRequest(controlDbPath: string): boolean {
	return withControlDb(controlDbPath, (db) =>
		Boolean(
			db
				.prepare("SELECT 1 FROM supervisor_requests WHERE status = 'pending' AND kind = 'approval_review' LIMIT 1")
				.get(),
		),
	);
}

export function requeueSupervisorRequest(controlDbPath: string, requestId: number, claimToken: string): void {
	withControlDb(controlDbPath, (db) => {
		const result = db
			.prepare(
				`UPDATE supervisor_requests
				 SET status = 'pending', claimed_at = NULL, claim_token = NULL
				 WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
			)
			.run(requestId, claimToken);
		if (result.changes !== 1) throw new Error(`Supervisor request claim lost: ${requestId}`);
	});
}

function isSupervisorResponseValidForRequest(
	requestKind: SupervisorRequestKind,
	responseKind: SupervisorResponse["kind"],
): boolean {
	if (responseKind === "error") return true;
	if (requestKind === "approval_review") return responseKind === "approve" || responseKind === "reject";
	return (
		responseKind === "complete" || responseKind === "continue" || responseKind === "pause" || responseKind === "wait"
	);
}

export function completeSupervisorRequest(
	controlDbPath: string,
	requestId: number,
	claimToken: string,
	response: SupervisorResponse,
): void {
	withControlDb(controlDbPath, (db) => {
		const request = db
			.prepare("SELECT kind FROM supervisor_requests WHERE id = ? AND status = 'claimed' AND claim_token = ?")
			.get(requestId, claimToken) as { kind: SupervisorRequestKind } | undefined;
		if (!request) throw new Error(`Supervisor request claim lost: ${requestId}`);
		if (!isSupervisorResponseValidForRequest(request.kind, response.kind)) {
			throw new Error(`Invalid Supervisor response kind ${response.kind} for ${request.kind}`);
		}
		const result = db
			.prepare(
				`UPDATE supervisor_requests
				 SET status = 'completed', completed_at = ?, response_json = ?
				 WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
			)
			.run(new Date().toISOString(), JSON.stringify(response), requestId, claimToken);
		if (result.changes !== 1) throw new Error(`Supervisor request claim lost: ${requestId}`);
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
		return row != null;
	});
}

function hasDeliverableRuntimeMailboxMessage(db: SqliteDatabase, recipient: RuntimeMailboxAddress): boolean {
	const rows = readCanonicalMailboxRowsForRecipient(db, recipient, "pending", Number.MAX_SAFE_INTEGER);
	return rows.some((row) => {
		const message = parseJsonObject(row.data);
		return message !== undefined && !isLifecycleNotificationPayload(message);
	});
}

export function isRuntimeCoordinationMailboxMessage(message: RuntimeMailboxMessage): boolean {
	return !isLifecycleNotificationPayload(message as unknown as Record<string, unknown>);
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
	withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const row = readCanonicalMailboxRowById(db, id);
			if (!row) return;
			const message = parseCanonicalMailboxPayload(row);
			if (message.status === "delivered") return;
			const now = new Date().toISOString();
			const delivered: Record<string, unknown> = {
				...message,
				status: "delivered",
				deliveredAt: now,
				updatedAt: now,
			};
			delete delivered.claimedAt;
			delete delivered.claimantProcessIdentity;
			compareAndWriteCanonicalMailboxPayload(db, row, delivered, now);
		}),
	);
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
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`SELECT rowid AS id, session_path, message_id, data, updated_at
				 FROM multi_agent_mailbox_messages
				 WHERE json_valid(data) AND json_type(data, '$.recipientSessionId') = 'text'
				 ORDER BY rowid ASC`,
			)
			.all() as RuntimeMailboxRow[];
		return rows.map((row) => runtimeMailboxMessageFromCanonicalRow(row, parseCanonicalMailboxPayload(row)));
	});
}

function runtimeMailboxMessageFromCanonicalRow(
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
		kind: toRuntimeMailboxMessageKind(requireStringField(message, "kind", context)),
		body: requireStringField(message, "body", context),
		fileRefs: parseFileRefs(message.fileRefs, context),
		targetCheckpoint: parseSteeringCheckpoint(message.targetCheckpoint, context),
		storeRef: { messageId: row.message_id, sessionPath: row.session_path },
		status: toRuntimeMailboxMessageStatus(requireStringField(message, "status", context)),
		createdAt: typeof message.createdAt === "string" ? message.createdAt : row.updated_at,
		updatedAt: typeof message.updatedAt === "string" ? message.updatedAt : row.updated_at,
		claimedAt: optionalStringField(message, "claimedAt", context),
		deliveredAt: optionalStringField(message, "deliveredAt", context),
		error: optionalStringField(message, "error", context),
	};
}

function nullableStringField(message: Record<string, unknown>, field: string, context: string): string | null {
	const value = message[field];
	if (value === null) return null;
	if (typeof value === "string") return value;
	throw new Error(`Invalid ${field} at ${context}`);
}

function optionalStringField(message: Record<string, unknown>, field: string, context: string): string | undefined {
	const value = message[field];
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	throw new Error(`Invalid ${field} at ${context}`);
}

function toRuntimeMailboxMessageKind(value: string): RuntimeMailboxMessageKind {
	if (
		value === "message" ||
		value === "ask" ||
		value === "reply" ||
		value === "steer" ||
		value === "parent_request" ||
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
			relocateMultiAgentRuntimeOwners(db, oldSessionPath, newSessionPath);
			relocateMultiAgentSessionRows(db, "multi_agent_terminal_outbox", oldSessionPath, newSessionPath, now);
			relocateMultiAgentSessionRows(db, "multi_agent_mailbox_messages", oldSessionPath, newSessionPath, now);
			relocateSessionPathPrimaryKey(db, "multi_agent_counters_v2", oldSessionPath, newSessionPath, now);
			relocateRuntimeMailboxListenerPaths(db, oldSessionPath, newSessionPath);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
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

function relocateMultiAgentRuntimeOwners(db: SqliteDatabase, oldSessionPath: string, newSessionPath: string): void {
	db.prepare("DELETE FROM multi_agent_runtime_owners WHERE session_path = ?").run(newSessionPath);
	db.prepare("UPDATE multi_agent_runtime_owners SET session_path = ? WHERE session_path = ?").run(
		newSessionPath,
		oldSessionPath,
	);
}

function relocateMultiAgentSessionRows(
	db: SqliteDatabase,
	table: "multi_agent_agents" | "multi_agent_mailbox_messages" | "multi_agent_terminal_outbox",
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
			null,
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

export function findActiveSessionMetadataById(controlDbPath: string, id: string): SessionMetadata[] {
	return findActiveSessionMetadata(controlDbPath, "id", id);
}

export function findActiveSessionMetadataByName(controlDbPath: string, name: string): SessionMetadata[] {
	return findActiveSessionMetadata(controlDbPath, "name", name);
}

function findActiveSessionMetadata(controlDbPath: string, field: "id" | "name", value: string): SessionMetadata[] {
	return withControlDb(controlDbPath, (db) => {
		const matchClause = field === "id" ? "id >= ? AND id < ?" : "name = ?";
		const values = field === "id" ? [value, `${value}\uffff`] : [value];
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
				WHERE archived_at IS NULL AND is_subagent = 0 AND ${matchClause}
				ORDER BY modified_at DESC, updated_at DESC, session_path DESC
				`,
			)
			.all(...values) as SessionMetadataRow[];
		return rows.map(sessionMetadataFromRow);
	});
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

export interface SupervisorRuntimeOwnership {
	agentId?: string;
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
	body: string;
	fileRefs?: AgentFileReference[];
	fromAgentId: string;
	recipient: RuntimeMailboxAddress;
	targetCheckpoint?: AgentMailboxMessage["targetCheckpoint"];
	threadId?: string;
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
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const agent = readSteeringMutationAgent(db, input);
			if (!agent) return { ok: false, error: "agent_not_found" };
			if (
				input.requestedLifecycle !== "steering_pending" ||
				!canPersistLifecycleTransition(agent.lifecycle, input.requestedLifecycle)
			) {
				return { ok: false, error: "invalid_transition" };
			}
			const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
			if (!steeringMutationHasAuthority(db, agent, ownership, input)) {
				return { ok: false, error: "mutation_mismatch" };
			}
			return persistSteeringMutation(db, agent, input);
		}),
	);
}

function readSteeringMutationAgent(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringMutationInput,
): AgentSnapshot | undefined {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.agentId) as { data: string } | undefined;
	if (!row) return undefined;
	const context = `multi_agent_agents:${input.sessionPath}#${input.agentId}`;
	const agent = parseStoredJsonObject(row.data, context);
	validatePersistedAgentPayload(agent, context);
	return agent as unknown as AgentSnapshot;
}

function steeringMutationHasAuthority(
	db: SqliteDatabase,
	agent: AgentSnapshot,
	ownership: MultiAgentRuntimeOwnershipRow | undefined,
	input: CommitMultiAgentSteeringMutationInput,
): boolean {
	if (!runtimeOwnershipMatchesLifecycleMutation(ownership, input)) return false;
	const senderListener = readRuntimeMailboxListenerRow(db, {
		agentId: input.owner.agentId,
		sessionId: input.owner.sessionId,
	});
	const recipientListener = readRuntimeMailboxListenerRow(db, input.recipient);
	const senderPathMatches =
		input.owner.agentId !== null ||
		(senderListener !== undefined && trustedRuntimeMailboxSessionPath(senderListener) === input.sessionPath);
	const expectedSenderId = input.owner.agentId ?? "supervisor";
	return (
		input.fromAgentId === expectedSenderId &&
		agent.parentId === (input.owner.agentId ?? "main") &&
		input.recipient.agentId === input.agentId &&
		input.recipient.sessionId === agent.transcript?.sessionId &&
		senderListener?.pid === process.pid &&
		senderListener.runtime_instance_id === RUNTIME_PROCESS_INSTANCE_ID &&
		senderPathMatches &&
		runtimeListenerMatchesProcessIdentity(recipientListener, ownership?.process_identity)
	);
}

function persistSteeringMutation(
	db: SqliteDatabase,
	agent: AgentSnapshot,
	input: CommitMultiAgentSteeringMutationInput,
): CommitMultiAgentSteeringMutationResult {
	const messageNumber = allocateMultiAgentCounterInTransaction(db, input.sessionPath, "message");
	const message: AgentMailboxMessage = {
		body: input.body,
		createdAt: input.updatedAt,
		fileRefs: input.fileRefs,
		fromAgentId: input.fromAgentId,
		id: `message_${messageNumber}`,
		kind: "steer",
		status: "pending",
		targetCheckpoint: input.targetCheckpoint,
		threadId: input.threadId,
		toAgentId: input.agentId,
		updatedAt: input.updatedAt,
	};
	validateMailboxPayload(message, `multi_agent_mailbox_messages:${input.sessionPath}#${message.id}`);
	const updated: AgentSnapshot = {
		...agent,
		lifecycle: input.requestedLifecycle as AgentSnapshot["lifecycle"],
		revision: agent.revision + 1,
		updatedAt: input.updatedAt,
	};
	persistImmutableMailboxPayload(db, {
		kind: message.kind,
		message,
		recipient: input.recipient,
		sender: input.owner,
		storeRef: { messageId: message.id, sessionPath: input.sessionPath },
		updatedAt: input.updatedAt,
	});
	db.prepare("UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?").run(
		JSON.stringify(updated),
		input.updatedAt,
		input.sessionPath,
		input.agentId,
	);
	return { agent: updated, message, ok: true };
}

function runtimeListenerMatchesProcessIdentity(
	listener: RuntimeMailboxListenerRow | undefined,
	serializedIdentity: string | null | undefined,
): boolean {
	if (!listener?.runtime_instance_id || !serializedIdentity) return false;
	try {
		const listenerIdentity = parseProcessIdentity(listener.runtime_instance_id);
		const processIdentity = parseProcessIdentity(serializedIdentity);
		return (
			listener.pid === processIdentity.pid &&
			listenerIdentity.pid === processIdentity.pid &&
			listenerIdentity.startTimeTicks === processIdentity.startTimeTicks &&
			isProcessIdentityAlive(processIdentity)
		);
	} catch {
		return false;
	}
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

export interface CommitMultiAgentDetachMarkInput {
	agentId: string;
	owner: { agentId: string | null; sessionId: string };
	processIdentity: ProcessIdentity;
	sessionPath: string;
	updatedAt: string;
}

export type CommitMultiAgentDetachMarkResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

/**
 * Mark an owned background job as detached from its waiting tool call.
 * Only detached jobs emit a terminal runtime-mailbox notification; attended
 * jobs deliver their result in-band through the waiting tool call.
 */
export function commitMultiAgentDetachMark(
	controlDbPath: string,
	input: CommitMultiAgentDetachMarkInput,
): CommitMultiAgentDetachMarkResult {
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
			if (!runtimeOwnerMatches(ownership, input)) {
				return { ok: false, error: "mutation_mismatch" };
			}
			if (!isRecoverableRuntimeLifecycle(agent.lifecycle)) {
				return { ok: false, error: "invalid_transition" };
			}
			if (agent.detached === true) {
				return { ok: true, agent: agent as unknown as AgentSnapshot };
			}
			const updated = {
				...agent,
				detached: true,
				revision: Number(agent.revision) + 1,
				updatedAt: input.updatedAt,
			};
			db.prepare(
				"UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?",
			).run(JSON.stringify(updated), input.updatedAt, input.sessionPath, input.agentId);
			validatePersistedAgentPayload(updated, context);
			return { ok: true, agent: updated as unknown as AgentSnapshot };
		}),
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
			recipientAgentId: input.agentId,
			recipientSessionId: input.owner.sessionId,
			senderAgentId: null,
			senderSessionId: input.owner.sessionId,
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
				currentActivity: undefined,
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
		withImmediateTransaction(db, () => {
			const sessionPath = findDetachedJobSessionPath(db, input);
			if (!sessionPath) return detachedJobLookupFailure(db, input);
			return finalizeDetachedJobTransaction(db, sessionPath, input.terminal);
		}),
	);
}

function findDetachedJobSessionPath(db: SqliteDatabase, input: FinalizeDetachedJobInput): string | undefined {
	const candidates = db
		.prepare("SELECT session_path FROM multi_agent_runtime_owners WHERE agent_id = ?")
		.all(input.terminal.jobId) as Array<{ session_path: string }>;
	const matchingPaths = candidates.filter(({ session_path: sessionPath }) => {
		const ownership = readMultiAgentRuntimeOwnershipRow(db, sessionPath, input.terminal.jobId);
		return runtimeOwnerMatches(ownership, {
			agentId: input.terminal.jobId,
			owner: input.terminal.owner,
			processIdentity: input.terminal.processIdentity,
			sessionPath,
		});
	});
	return matchingPaths.length === 1 ? matchingPaths[0]?.session_path : undefined;
}

function detachedJobLookupFailure(db: SqliteDatabase, input: FinalizeDetachedJobInput): FinalizeDetachedJobResult {
	const agent = db
		.prepare("SELECT 1 FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.terminal.jobId);
	return agent ? { ok: false, error: "mutation_mismatch" } : { ok: false, error: "agent_not_found" };
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
		terminalAgent,
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
		...detachedJobAgentDetails(agent, terminal, terminalLifecycle),
		currentActivity: undefined,
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
	// Attended jobs deliver their result in-band through the waiting tool call;
	// only jobs explicitly detached from their tool call notify the supervisor.
	if (agent.detached === true) {
		persistDetachedJobTerminalTransport(db, sessionPath, terminal, ownership, terminalRevision, eventKind);
	}
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
	persistDetachedAgentTerminalTransport(
		db,
		sessionPath,
		terminal.jobId,
		{
			agentId: ownership.owner_agent_id,
			sessionId: ownership.owner_session_id ?? undefined,
		},
		terminalRevision,
		eventKind,
		terminal.terminalAt,
	);
}

function persistDetachedAgentTerminalTransport(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
	owner: { agentId: string | null; sessionId?: string },
	terminalRevision: number,
	eventKind: string,
	terminalAt: string,
): void {
	const ownerSessionId = owner.sessionId;
	if (!ownerSessionId) throw new Error(`Detached job ${agentId} ownership has no owner session`);
	const messageId = `terminal:${agentId}:${terminalRevision}:${eventKind}`;
	const body = JSON.stringify({ agentId, eventKind, terminalRevision, type: "multi_agent_terminal" });
	persistStoredRuntimeMailboxMessage(db, {
		kind: "system",
		message: {
			body,
			createdAt: terminalAt,
			fromAgentId: agentId,
			id: messageId,
			kind: "system",
			status: "pending",
			toAgentId: owner.agentId ?? "main",
			updatedAt: terminalAt,
		},
		recipient: { agentId: owner.agentId, sessionId: ownerSessionId },
		sender: { agentId, sessionId: ownerSessionId },
		storeRef: { messageId, sessionPath },
		updatedAt: terminalAt,
	});
}

function detachedJobAgentDetails(
	agent: Record<string, unknown>,
	terminal: DetachedJobTerminalInput,
	terminalLifecycle: "completed" | "failed" | "aborted",
): Record<string, unknown> {
	const result = agent.result;
	const existingFileRefs =
		result && typeof result === "object" && !Array.isArray(result)
			? (parseFileRefs((result as Record<string, unknown>).fileRefs, `detached job ${terminal.jobId} result`) ?? [])
			: [];
	const outputRef = { label: terminal.output.label, path: terminal.output.path };
	const fileRefs = [
		outputRef,
		...existingFileRefs.filter((fileRef) => fileRef.label !== outputRef.label || fileRef.path !== outputRef.path),
	];
	const timing = terminal.durationMs === undefined ? {} : { durationMs: terminal.durationMs };
	const correlation = terminal.toolCallId === undefined ? {} : { toolCallId: terminal.toolCallId };
	if (terminalLifecycle === "aborted") return { result: { fileRefs, ...timing, ...correlation } };
	if (terminal.outcome.kind === "completed") {
		return { result: { fileRefs, summary: terminal.outcome.summary, ...timing, ...correlation } };
	}
	if (terminal.outcome.kind === "failed") {
		return {
			error: terminal.outcome.error,
			result: { fileRefs, summary: terminal.outcome.error.message, ...timing, ...correlation },
		};
	}
	return { result: { fileRefs, ...timing, ...correlation } };
}

export function recoverDeadMultiAgentRuntime(
	controlDbPath: string,
	input: RecoverDeadMultiAgentRuntimeInput,
): RecoverDeadMultiAgentRuntimeResult {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			if (!registeredSupervisorOwnsSession(db, input.expectedOwner.sessionPath, input.supervisor)) {
				return { ok: false, error: "mutation_mismatch" };
			}
			return recoverDeadMultiAgentRuntimeInTransaction(db, input.expectedOwner, input.nowIso);
		}),
	);
}

interface DeadDetachedRuntimeCandidate {
	agent_id: string;
	data: string;
	owner_agent_id: string | null;
	owner_session_id: string | null;
	process_identity: string | null;
	session_path: string;
}

export function reconcileDeadDetachedAgentRuntimes(controlDbPath: string, nowIso: string): number {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			let reconciled = 0;
			for (const candidate of readDeadDetachedRuntimeCandidates(db)) {
				const expectedOwner = readDetachedOwnerForRecovery(db, candidate);
				if (!expectedOwner) continue;
				const result = recoverDeadMultiAgentRuntimeInTransaction(db, expectedOwner, nowIso);
				if (result.ok) reconciled += 1;
			}
			return reconciled;
		}),
	);
}

function readDeadDetachedRuntimeCandidates(db: SqliteDatabase): DeadDetachedRuntimeCandidate[] {
	return db
		.prepare(
			`SELECT agents.session_path, agents.agent_id, agents.data, owners.process_identity,
			 owners.owner_session_id, owners.owner_agent_id
			 FROM multi_agent_agents AS agents
			 JOIN multi_agent_runtime_owners AS owners
			 ON owners.session_path = agents.session_path AND owners.agent_id = agents.agent_id
			 WHERE json_valid(agents.data)
			 AND json_extract(agents.data, '$.lifecycle') IN ('running', 'cancelling')
			 AND json_extract(agents.data, '$.detached') = 1`,
		)
		.all() as DeadDetachedRuntimeCandidate[];
}

function readDetachedOwnerForRecovery(
	db: SqliteDatabase,
	candidate: DeadDetachedRuntimeCandidate,
): MultiAgentRuntimeOwnershipIdentity | undefined {
	if (!candidate.owner_session_id || !candidate.process_identity) return undefined;
	const context = `multi_agent_agents:${candidate.session_path}#${candidate.agent_id}`;
	const agent = parseStoredJsonObject(candidate.data, context);
	validatePersistedAgentPayload(agent, context);
	const processIdentity = parseProcessIdentity(candidate.process_identity);
	const worker = agent.worker as AgentSnapshot["worker"] | undefined;
	if (worker?.adapter !== "runtime" || worker.handleId !== String(processIdentity.pid)) return undefined;
	if (hasTerminalOutboxRecord(db, candidate.session_path, candidate.agent_id)) return undefined;
	return {
		agentId: candidate.agent_id,
		owner: { agentId: candidate.owner_agent_id, sessionId: candidate.owner_session_id },
		processIdentity,
		sessionPath: candidate.session_path,
	};
}

function hasTerminalOutboxRecord(db: SqliteDatabase, sessionPath: string, agentId: string): boolean {
	return Boolean(
		db
			.prepare("SELECT 1 FROM multi_agent_terminal_outbox WHERE session_path = ? AND agent_id = ? LIMIT 1")
			.get(sessionPath, agentId),
	);
}

function recoverDeadMultiAgentRuntimeInTransaction(
	db: SqliteDatabase,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
	nowIso: string,
): RecoverDeadMultiAgentRuntimeResult {
	const { agentId, sessionPath } = expectedOwner;
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, agentId) as { data: string } | undefined;
	if (!row) return { ok: false, error: "agent_not_found" };
	const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${sessionPath}#${agentId}`);
	if (!isRecoverableRuntimeLifecycle(agent.lifecycle)) return { ok: false, error: "invalid_transition" };
	const owner = readMultiAgentRuntimeOwnershipRow(db, sessionPath, agentId);
	if (!runtimeOwnerMatches(owner, expectedOwner)) return { ok: false, error: "mutation_mismatch" };
	if (hasActivePersistedDescendant(db, sessionPath, agentId)) return { ok: false, error: "invalid_transition" };
	if (isProcessIdentityAlive(expectedOwner.processIdentity)) return { ok: false, error: "owner_alive" };
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
			serializeProcessIdentity(expectedOwner.processIdentity),
			expectedOwner.owner.sessionId,
			expectedOwner.owner.agentId,
		);
	if (released.changes !== 1) return { ok: false, error: "mutation_mismatch" };
	const terminalRevision = Number(agent.revision) + 1;
	const cancelling = agent.lifecycle === "cancelling";
	const error = {
		code: "lost_runtime",
		message: cancelling
			? "Cancellation requested; agent owner process exited before terminal confirmation."
			: "Agent owner process exited before terminal confirmation.",
	};
	const worker = agent.worker as AgentSnapshot["worker"] | undefined;
	const result = agent.result as AgentSnapshot["result"] | undefined;
	const toolCallId = worker?.toolCallId;
	const updated = {
		...agent,
		error,
		lifecycle: cancelling ? "aborted" : "failed",
		...(toolCallId === undefined ? {} : { result: { ...result, toolCallId } }),
		revision: terminalRevision,
		updatedAt: nowIso,
		worker: undefined,
	};
	db.prepare("UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?").run(
		JSON.stringify(updated),
		nowIso,
		sessionPath,
		agentId,
	);
	db.prepare(
		`INSERT INTO multi_agent_terminal_outbox
			(session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at)
		 VALUES (?, ?, ?, 'lost_runtime', 'pending', 0, ?)`,
	).run(sessionPath, agentId, terminalRevision, nowIso);
	if (agent.detached === true) {
		persistDetachedAgentTerminalTransport(
			db,
			sessionPath,
			agentId,
			expectedOwner.owner,
			terminalRevision,
			"lost_runtime",
			nowIso,
		);
	}
	return { ok: true, agent: updated, terminalRevision };
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
			if (!parentId || !hasActiveParent(db, input.sessionPath, parentId)) {
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

function hasActiveParent(db: SqliteDatabase, sessionPath: string, parentId: string): boolean {
	if (parentId === "main") return true;
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, parentId) as { data: string } | undefined;
	if (!row) return false;
	const parent = parseStoredJsonObject(row.data, `multi_agent_agents:${sessionPath}#${parentId}`);
	validatePersistedAgentPayload(parent, `multi_agent_agents:${sessionPath}#${parentId}`);
	return isNonterminalLifecycle(parent.lifecycle);
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
			if (!parentId || !hasActiveParent(db, input.sessionPath, parentId)) {
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
				if (!isNonterminalLifecycle(parent.lifecycle)) return { ok: false, error: "parent_not_found" };
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
	const recipientAgentIdKey = supervisor.agentId ?? "";
	const listener = db
		.prepare(
			`SELECT runtime_instance_id, session_path, session_path_asserted_at
			 FROM runtime_mailbox_listeners
			 WHERE recipient_session_id = ? AND recipient_agent_id_key = ? AND pid = ?`,
		)
		.get(supervisor.sessionId, recipientAgentIdKey, supervisor.processIdentity.pid) as
		| { runtime_instance_id: string | null; session_path: string | null; session_path_asserted_at: string | null }
		| undefined;
	if (!listener?.runtime_instance_id) return false;
	if (supervisor.agentId) {
		const supervisorAgent = db
			.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
			.get(sessionPath, supervisor.agentId) as { data: string } | undefined;
		if (!supervisorAgent) return false;
		const snapshot = parseStoredJsonObject(
			supervisorAgent.data,
			`multi_agent_agents:${sessionPath}#${supervisor.agentId}`,
		) as unknown as AgentSnapshot;
		if (snapshot.transcript?.sessionId !== supervisor.sessionId || !isActiveLifecycle(snapshot.lifecycle))
			return false;
	} else if (listener.session_path !== sessionPath || listener.session_path_asserted_at === null) {
		return false;
	}
	try {
		return (
			serializeProcessIdentity(parseProcessIdentity(listener.runtime_instance_id)) ===
			serializeProcessIdentity(supervisor.processIdentity)
		);
	} catch {
		return false;
	}
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

export function updateMultiAgentAgentCurrentActivity(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	currentActivity: AgentSnapshot["currentActivity"],
	updatedAt: string,
	ownership: { ownerSessionId: string; processIdentity: ProcessIdentity },
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(controlDbPath, sessionPath, agentId, { currentActivity }, updatedAt, ownership);
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

function multiAgentActivityOwnershipMatches(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
	ownership: { ownerSessionId: string; processIdentity: ProcessIdentity },
): boolean {
	const runtimeOwnership = readMultiAgentRuntimeOwnershipRow(db, sessionPath, agentId);
	return (
		runtimeOwnership?.owner_session_id === ownership.ownerSessionId &&
		runtimeOwnership.owner_agent_id === null &&
		runtimeOwnership.process_identity === serializeProcessIdentity(ownership.processIdentity)
	);
}

function permitsMultiAgentCurrentActivity(
	agent: Record<string, unknown>,
	metadata:
		| Pick<AgentSnapshot, "currentActivity">
		| Pick<AgentSnapshot, "lastActivity">
		| Pick<AgentSnapshot, "slot">
		| Pick<AgentSnapshot, "transcript">,
): boolean {
	return (
		!("currentActivity" in metadata) ||
		metadata.currentActivity === undefined ||
		agent.lifecycle === "running" ||
		agent.lifecycle === "steering_pending"
	);
}

function updateMultiAgentAgentMetadata(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	metadata:
		| Pick<AgentSnapshot, "currentActivity">
		| Pick<AgentSnapshot, "lastActivity">
		| Pick<AgentSnapshot, "slot">
		| Pick<AgentSnapshot, "transcript">,
	updatedAt: string,
	activityOwnership?: { ownerSessionId: string; processIdentity: ProcessIdentity },
): AgentSnapshot | undefined {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const row = db
				.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(sessionPath, agentId) as { data: string } | undefined;
			if (!row) return undefined;
			const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${sessionPath}#${agentId}`);
			validatePersistedAgentPayload(agent, `multi_agent_agents:${sessionPath}#${agentId}`);
			if (activityOwnership && !multiAgentActivityOwnershipMatches(db, sessionPath, agentId, activityOwnership)) {
				return undefined;
			}
			if (!permitsMultiAgentCurrentActivity(agent, metadata)) return undefined;
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
			validateParentRequestTarget(db, sessionPath, data);
			let serialized = JSON.stringify(data);
			const existing = db
				.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
				.get(sessionPath, id) as { data: string } | undefined;
			if (existing) {
				const previous = parseJsonObject(existing.data);
				const next = parseJsonObject(serialized);
				if (!previous || !next || !sameMailboxMessageIdentity(previous, next, id)) {
					throw new Error(`Mailbox message ID collision: ${sessionPath}#${id}`);
				}
				serialized = JSON.stringify(mergeCanonicalMailboxUpdate(previous, next));
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

function mergeCanonicalMailboxUpdate(
	previous: Record<string, unknown>,
	next: Record<string, unknown>,
): Record<string, unknown> {
	const routing = {
		recipientAgentId: previous.recipientAgentId,
		recipientSessionId: previous.recipientSessionId,
		senderAgentId: previous.senderAgentId,
		senderSessionId: previous.senderSessionId,
	};
	if (next.status === "pending" && previous.status === "claimed") {
		return {
			...next,
			...routing,
			claimedAt: previous.claimedAt,
			claimantProcessIdentity: previous.claimantProcessIdentity,
			status: "claimed",
		};
	}
	return { ...next, ...routing };
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

function validateParentRequestTarget(db: SqliteDatabase, sessionPath: string, data: unknown): void {
	if (!data || typeof data !== "object" || Array.isArray(data)) return;
	const payload = data as Record<string, unknown>;
	if (payload.kind !== "parent_request") return;
	const fromAgentId = requireStringField(payload, "fromAgentId", "parent_request");
	const toAgentId = requireStringField(payload, "toAgentId", "parent_request");
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, fromAgentId) as { data: string } | undefined;
	const sender = row ? parseJsonObject(row.data) : undefined;
	if (!sender || sender.parentId !== toAgentId) {
		throw new Error(`Invalid parent request target at ${sessionPath}#${fromAgentId}`);
	}
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
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => allocateMultiAgentCounterInTransaction(db, sessionPath, counterName)),
	);
}

function allocateMultiAgentCounterInTransaction(
	db: SqliteDatabase,
	sessionPath: string,
	counterName: MultiAgentCounterName,
): number {
	const column = MULTI_AGENT_COUNTER_COLUMNS[counterName];
	const row = db
		.prepare("SELECT next_agent_number, next_message_number FROM multi_agent_counters_v2 WHERE session_path = ?")
		.get(sessionPath) as MultiAgentCounterRow | undefined;
	const counters = {
		next_agent_number: row?.next_agent_number ?? 1,
		next_message_number: row?.next_message_number ?? 1,
	};
	const allocated = counters[column];
	counters[column] = allocated + 1;
	db.prepare(
		`INSERT INTO multi_agent_counters_v2 (session_path, next_agent_number, next_message_number, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(session_path) DO UPDATE SET
		  next_agent_number = excluded.next_agent_number,
		  next_message_number = excluded.next_message_number,
		  updated_at = excluded.updated_at`,
	).run(sessionPath, counters.next_agent_number, counters.next_message_number, new Date().toISOString());
	return allocated;
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

export function prepareControlDbForSelfRestart(controlDbPath: string, processId: number): void {
	const db = createSqliteDatabase(controlDbPath);
	try {
		configureSharedSqliteDatabase(db);
		initializeSchema(db, processId);
	} finally {
		db.close();
	}
}

type RetainedControlDb = {
	activeCalls: number;
	db: SqliteDatabase;
	retainCount: number;
};

const retainedControlDbs = new Map<string, RetainedControlDb>();

export function retainControlDbConnection(controlDbPath: string): () => void {
	const retained = retainedControlDbs.get(controlDbPath) ?? openRetainedControlDb(controlDbPath);
	retained.retainCount += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		retained.retainCount -= 1;
		closeReleasedControlDb(controlDbPath, retained);
	};
}

function createWritableControlDb(controlDbPath: string): SqliteDatabase {
	mkdirSync(dirname(controlDbPath), { mode: 0o700, recursive: true });
	return createSqliteDatabase(controlDbPath);
}

function openRetainedControlDb(controlDbPath: string): RetainedControlDb {
	const db = createWritableControlDb(controlDbPath);
	try {
		configureSharedSqliteDatabase(db);
		initializeSchema(db);
		db.finalizeStatements?.();
	} catch (error) {
		db.close();
		throw error;
	}
	const retained = { activeCalls: 0, db, retainCount: 0 };
	retainedControlDbs.set(controlDbPath, retained);
	return retained;
}

function closeReleasedControlDb(controlDbPath: string, retained: RetainedControlDb): void {
	if (retained.retainCount > 0 || retained.activeCalls > 0) return;
	retainedControlDbs.delete(controlDbPath);
	retained.db.close();
}

function withControlDb<T>(controlDbPath: string, callback: (db: SqliteDatabase) => T): T {
	const retained = retainedControlDbs.get(controlDbPath);
	if (retained) {
		retained.activeCalls += 1;
		try {
			return callback(retained.db);
		} finally {
			retained.activeCalls -= 1;
			if (retained.activeCalls === 0) retained.db.finalizeStatements?.();
			closeReleasedControlDb(controlDbPath, retained);
		}
	}
	const db = createWritableControlDb(controlDbPath);
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

function initializeSchema(db: SqliteDatabase, selfRestartProcessId?: number): void {
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

		CREATE INDEX IF NOT EXISTS session_metadata_id_idx
		ON session_metadata(id);

		CREATE INDEX IF NOT EXISTS session_metadata_name_idx
		ON session_metadata(name);

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

		CREATE INDEX IF NOT EXISTS multi_agent_mailbox_recipient_status_idx
		ON multi_agent_mailbox_messages(
			CASE WHEN json_valid(data) THEN json_extract(data, '$.recipientSessionId') END,
			CASE WHEN json_valid(data) THEN json_extract(data, '$.recipientAgentId') END,
			CASE WHEN json_valid(data) THEN json_extract(data, '$.status') END
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
			project_cwd TEXT,
			body TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			claimed_at TEXT,
			claim_token TEXT,
			completed_at TEXT
		);

		CREATE INDEX IF NOT EXISTS architect_requests_status_id_idx
		ON architect_requests(status, id);

		CREATE TABLE IF NOT EXISTS supervisor_requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sender_session_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			deadline_at TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			claimed_at TEXT,
			claim_token TEXT,
			completed_at TEXT,
			response_json TEXT
		);

		CREATE INDEX IF NOT EXISTS supervisor_requests_priority_idx
		ON supervisor_requests(status, kind, id);

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
	const schemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (schemaVersion.user_version >= CONTROL_DB_SCHEMA_VERSION) migrateLegacyMultiAgentCounters(db);
	migrateLegacyMultiAgentPayloads(db, selfRestartProcessId);
	addMissingSessionMetadataColumns(db);
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

function migrateLegacyMultiAgentPayloads(db: SqliteDatabase, selfRestartProcessId?: number): void {
	const schemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (schemaVersion.user_version >= CONTROL_DB_SCHEMA_VERSION) return;

	withImmediateTransaction(db, () => {
		const currentSchemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (currentSchemaVersion.user_version >= CONTROL_DB_SCHEMA_VERSION) return;
		assertLifecycleProtocolMigrationQuiescent(db, selfRestartProcessId);

		migrateLegacyMultiAgentCounters(db);
		dropLifecycleAccessControlTriggers(db);
		db.exec("DROP TABLE IF EXISTS multi_agent_recovery_leader");
		migrateTerminalOutboxSchema(db);
		migrateRuntimeOwnerTable(db);
		const now = new Date().toISOString();
		migrateLegacyLifecycleRows(db, now);
		migrateLegacyMultiAgentPayloadTable(db, "multi_agent_agents", "agent_id", now);
		migrateLegacyMultiAgentPayloadTable(db, "multi_agent_mailbox_messages", "message_id", now);
		migrateLegacyRuntimeMailboxMessages(db, now);
		createLegacyArtifactFieldTriggers(db);
		db.exec(`PRAGMA user_version = ${CONTROL_DB_SCHEMA_VERSION}`);
	});
}

function assertLifecycleProtocolMigrationQuiescent(db: SqliteDatabase, selfRestartProcessId?: number): void {
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
	const uniqueLivePids = [...new Set(liveRuntimePids)].filter((pid) => pid !== selfRestartProcessId);
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

type LegacyRuntimeMailboxRow = {
	recipient_session_id: string;
	recipient_agent_id: string | null;
	sender_session_id: string | null;
	sender_agent_id: string | null;
	kind: string;
	store_session_path: string;
	store_message_id: string;
	status: string;
	created_at: string;
	updated_at: string;
	delivered_at: string | null;
	error: string | null;
};

function migrateLegacyRuntimeMailboxMessages(db: SqliteDatabase, nowIso: string): void {
	const tableExists = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_mailbox_messages'")
		.get();
	if (!tableExists) return;
	const columns = new Set(
		(db.prepare("PRAGMA table_info(runtime_mailbox_messages)").all() as TableInfoRow[]).map((column) => column.name),
	);
	if (!columns.has("store_session_path") || !columns.has("store_message_id")) {
		db.exec("DROP TABLE runtime_mailbox_messages");
		return;
	}
	const rows = db
		.prepare(
			`SELECT recipient_session_id, recipient_agent_id, sender_session_id, sender_agent_id,
			        kind, store_session_path, store_message_id, status, created_at, updated_at,
			        delivered_at, error
			 FROM runtime_mailbox_messages
			 WHERE store_session_path IS NOT NULL AND store_message_id IS NOT NULL
			 ORDER BY CASE status WHEN 'delivered' THEN 4 WHEN 'failed' THEN 3 WHEN 'claimed' THEN 2 ELSE 1 END DESC,
			          updated_at DESC, id DESC`,
		)
		.all() as LegacyRuntimeMailboxRow[];
	const migrated = new Set<string>();
	for (const row of rows) {
		const key = `${row.store_session_path}\u0000${row.store_message_id}`;
		if (migrated.has(key)) continue;
		migrated.add(key);
		migrateLegacyRuntimeMailboxRow(db, row, nowIso);
	}
	db.exec(`
		DROP INDEX IF EXISTS runtime_mailbox_store_ref_unique_idx;
		DROP INDEX IF EXISTS runtime_mailbox_recipient_status_idx;
		DROP INDEX IF EXISTS runtime_mailbox_created_at_idx;
		DROP TABLE runtime_mailbox_messages;
	`);
}

function migrateLegacyRuntimeMailboxRow(db: SqliteDatabase, row: LegacyRuntimeMailboxRow, nowIso: string): void {
	const storeRef = { messageId: row.store_message_id, sessionPath: row.store_session_path };
	const canonical = readCanonicalMailboxRowByStoreRef(db, storeRef);
	if (!canonical) return;
	const context = `multi_agent_mailbox_messages:${row.store_session_path}#${row.store_message_id}`;
	const message = parseStoredJsonObject(canonical.data, context);
	validateMailboxPayload(message, context);
	const routed = addRuntimeMailboxRouting(message, {
		kind: toRuntimeMailboxMessageKind(row.kind),
		recipient: { agentId: row.recipient_agent_id, sessionId: row.recipient_session_id },
		sender: { agentId: row.sender_agent_id, sessionId: row.sender_session_id ?? "" },
		storeRef,
	});
	const canonicalStatus = toRuntimeMailboxMessageStatus(requireStringField(routed, "status", context));
	const legacyStatus = row.status === "claimed" ? "pending" : toRuntimeMailboxMessageStatus(row.status);
	const status = canonicalStatus === "delivered" || canonicalStatus === "failed" ? canonicalStatus : legacyStatus;
	const updated: Record<string, unknown> = {
		...routed,
		createdAt: typeof routed.createdAt === "string" ? routed.createdAt : row.created_at,
		status,
		updatedAt: row.updated_at || nowIso,
	};
	delete updated.claimedAt;
	delete updated.claimantProcessIdentity;
	if (status === "delivered") {
		updated.deliveredAt =
			typeof routed.deliveredAt === "string" ? routed.deliveredAt : (row.delivered_at ?? row.updated_at);
	}
	if (status === "failed") {
		updated.error = typeof routed.error === "string" ? routed.error : row.error;
	}
	writeCanonicalMailboxPayload(db, canonical.id, updated, row.updated_at || nowIso);
}

function addMissingArchitectRequestColumns(db: SqliteDatabase): void {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(architect_requests)").all() as TableInfoRow[]).map((column) => column.name),
	);
	if (!columns.has("project_cwd")) db.exec("ALTER TABLE architect_requests ADD COLUMN project_cwd TEXT");
	if (!columns.has("claimed_at")) db.exec("ALTER TABLE architect_requests ADD COLUMN claimed_at TEXT");
	if (!columns.has("claim_token")) db.exec("ALTER TABLE architect_requests ADD COLUMN claim_token TEXT");
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
