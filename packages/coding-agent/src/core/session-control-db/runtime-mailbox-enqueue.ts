import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isMailboxMessageExpired, MAILBOX_MESSAGE_RETENTION_MS } from "../mailbox-retention.ts";
import type { RuntimeMailboxAcceptanceCheck } from "../runtime-mailbox-transcript.ts";
import {
	isProcessIdentityAlive,
	isSupersededRuntimeIdentity,
	isVerifiedPiRuntimeProcess,
	readProcessIdentity,
} from "../runtime-process.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import {
	addRuntimeMailboxRouting,
	assertRuntimeMailboxRouting,
	parseStoredJsonObject,
	requireStringField,
	stripRuntimeMailboxDeliveryState,
	validateMailboxPayload,
} from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import { parseProcessIdentity, withImmediateTransaction } from "./helpers.ts";
import { readCanonicalMailboxRowsForRecipient, runtimeMailboxAgentIdKey } from "./shared-channel.ts";
import {
	type EnqueueRuntimeMailboxMessageInput,
	type EnqueueStoredRuntimeMailboxMessageInput,
	MAILBOX_CREATED_AT_MS_SQL,
	type RuntimeMailboxAddress,
	type RuntimeMailboxListenerRow,
	type RuntimeMailboxRow,
	type RuntimeMailboxStoreRef,
} from "./types.ts";

export const RUNTIME_PROCESS_INSTANCE_ID_KEY = Symbol.for("@earendil-works/pi/runtime-process-instance-id");

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

export const RUNTIME_PROCESS_INSTANCE_ID = getRuntimeProcessInstanceId();

export const RUNTIME_MAILBOX_ROUTING_MAX_ATTEMPTS = 3;

export function assertMailboxMessageFresh(message: Record<string, unknown>, context: string): void {
	if (isMailboxMessageExpired(message.createdAt, Date.now())) {
		throw new Error(`Expired mailbox message at ${context}`);
	}
}

export function enqueueRuntimeMailboxMessage(controlDbPath: string, input: EnqueueRuntimeMailboxMessageInput): number {
	const result = withControlDb(controlDbPath, (db) => routeRuntimeMailboxMessage(db, input));
	if (!input.recipientHost || input.recipientHost === hostname()) notifyRuntimeMailboxListener(result.listener);
	return result.id;
}

export function routeRuntimeMailboxMessage(db: SqliteDatabase, input: EnqueueRuntimeMailboxMessageInput) {
	for (let attempt = 1; attempt <= RUNTIME_MAILBOX_ROUTING_MAX_ATTEMPTS; attempt += 1) {
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
		if (JSON.stringify(routed) === row.data) return { id: row.id, listener: undefined };
		const serialized = JSON.stringify(routed);
		if (
			!withImmediateTransaction(db, () =>
				compareAndWriteSerializedCanonicalMailboxPayload(db, row, serialized, new Date().toISOString()),
			)
		)
			continue;
		return { id: row.id, listener: readRuntimeMailboxListenerRow(db, input.recipient) };
	}
	throw new Error(
		`Runtime mailbox row changed while routing: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`,
	);
}

export type PreparedStoredRuntimeMailboxMessage = {
	defaultedBirth: boolean;
	context: string;
	routed: Record<string, unknown>;
	serialized: string;
	updatedAt: string;
};

export function enqueueStoredRuntimeMailboxMessage(
	controlDbPath: string,
	input: EnqueueStoredRuntimeMailboxMessageInput,
): number {
	const prepared = prepareStoredRuntimeMailboxMessage(input);
	const result = withControlDb(controlDbPath, (db) => {
		const existing = readCanonicalMailboxRowByStoreRef(db, input.storeRef);
		if (existing) return validateExistingStoredRuntimeMailboxMessage(existing, input, prepared);
		return withImmediateTransaction(db, () => persistStoredRuntimeMailboxMessage(db, input, prepared));
	});
	if (!input.recipientHost || input.recipientHost === hostname()) notifyRuntimeMailboxListener(result.listener);
	return result.id;
}

/** Caller owns the transaction and must notify the recipient after commit. */

export function enqueueStoredRuntimeMailboxMessageInTransaction(
	db: SqliteDatabase,
	input: EnqueueStoredRuntimeMailboxMessageInput,
): number {
	return persistStoredRuntimeMailboxMessage(db, input, prepareStoredRuntimeMailboxMessage(input)).id;
}

export function notifyRuntimeMailboxRecipient(controlDbPath: string, recipient: RuntimeMailboxAddress): void {
	withControlDb(controlDbPath, (db) => notifyRuntimeMailboxListener(readRuntimeMailboxListenerRow(db, recipient)));
}

export function prepareStoredRuntimeMailboxMessage(
	input: EnqueueStoredRuntimeMailboxMessageInput,
): PreparedStoredRuntimeMailboxMessage {
	const context = `multi_agent_mailbox_messages:${input.storeRef.sessionPath}#${input.storeRef.messageId}`;
	validateMailboxPayload(input.message, context);
	const incoming = parseStoredJsonObject(JSON.stringify(input.message), context);
	const defaultedBirth = incoming.createdAt == null;
	if (defaultedBirth) incoming.createdAt = new Date().toISOString();
	const routed = addRuntimeMailboxRouting(incoming, input);
	assertMailboxMessageFresh(routed, context);
	return {
		defaultedBirth,
		context,
		routed,
		serialized: JSON.stringify(routed),
		updatedAt: input.updatedAt ?? new Date().toISOString(),
	};
}

export function persistStoredRuntimeMailboxMessage(
	db: SqliteDatabase,
	input: EnqueueStoredRuntimeMailboxMessageInput,
	prepared: PreparedStoredRuntimeMailboxMessage,
) {
	assertMailboxMessageFresh(prepared.routed, prepared.context);
	const existing = readCanonicalMailboxRowByStoreRef(db, input.storeRef);
	if (existing) return validateExistingStoredRuntimeMailboxMessage(existing, input, prepared);
	const inserted = db
		.prepare(
			`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(session_path, message_id) DO NOTHING`,
		)
		.run(input.storeRef.sessionPath, input.storeRef.messageId, prepared.serialized, prepared.updatedAt);
	if (inserted.changes === 1) {
		return {
			id: Number(inserted.lastInsertRowid),
			listener: readRuntimeMailboxListenerRow(db, input.recipient),
		};
	}
	const concurrent = readCanonicalMailboxRowByStoreRef(db, input.storeRef);
	if (!concurrent) {
		throw new Error(
			`Runtime mailbox store reference disappeared after insert conflict: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`,
		);
	}
	return validateExistingStoredRuntimeMailboxMessage(concurrent, input, prepared);
}

export function validateExistingStoredRuntimeMailboxMessage(
	existing: RuntimeMailboxRow,
	input: EnqueueStoredRuntimeMailboxMessageInput,
	prepared: PreparedStoredRuntimeMailboxMessage,
) {
	const previous = parseStoredJsonObject(existing.data, prepared.context);
	assertMailboxMessageFresh(previous, prepared.context);
	if (!sameMailboxMessageIdentity(previous, prepared.routed, input.storeRef.messageId)) {
		throw new Error(`Mailbox message ID collision: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`);
	}
	assertRuntimeMailboxRouting(previous, input);
	// Omitted birth is not a new identity on retries; explicit dates still participate in collision checks.
	if (
		stripRuntimeMailboxDeliveryState(existing.data, prepared.defaultedBirth) !==
		stripRuntimeMailboxDeliveryState(prepared.serialized, prepared.defaultedBirth)
	) {
		throw new Error(`Mailbox message ID collision: ${input.storeRef.sessionPath}#${input.storeRef.messageId}`);
	}
	return { id: existing.id, listener: undefined };
}

export type RuntimeMailboxAuthoritySnapshot = {
	listener: RuntimeMailboxListenerRow | undefined;
	ownership: MultiAgentRuntimeOwnershipRow | undefined;
};

export type RuntimeMailboxCandidate = {
	authority: RuntimeMailboxAuthoritySnapshot;
	data: Record<string, unknown>;
	row: RuntimeMailboxRow;
};

export function recoverDeadRuntimeMailboxClaims(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	isAccepted: RuntimeMailboxAcceptanceCheck,
): number {
	return withControlDb(controlDbPath, (db) => {
		const candidates = readRecoverableRuntimeMailboxClaims(db, recipient);
		const nowIso = new Date().toISOString();
		return candidates.reduce(
			(recovered, candidate) =>
				recovered + Number(recoverRuntimeMailboxClaim(db, recipient, candidate, nowIso, isAccepted)),
			0,
		);
	});
}

export function readRecoverableRuntimeMailboxClaims(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
): RuntimeMailboxCandidate[] {
	const rows = readCanonicalMailboxRowsForRecipient(db, recipient, "claimed", Number.MAX_SAFE_INTEGER);
	return rows.flatMap((row) => {
		const authority = readRuntimeMailboxAuthoritySnapshot(db, recipient, row.session_path);
		if (!currentRuntimeOwnsMailboxAuthority(recipient, authority)) return [];
		const data = parseCanonicalMailboxPayload(row);
		const claimant = requireStringField(data, "claimantProcessIdentity", "runtime_mailbox_claim");
		return runtimeMailboxClaimantIsLive(claimant) ? [] : [{ authority, data, row }];
	});
}

export function recoverRuntimeMailboxClaim(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	candidate: RuntimeMailboxCandidate,
	nowIso: string,
	isAccepted: RuntimeMailboxAcceptanceCheck,
): boolean {
	const accepted = isAccepted({ sessionPath: candidate.row.session_path, messageId: candidate.row.message_id });
	const pending: Record<string, unknown> = { ...candidate.data, status: "pending", updatedAt: nowIso };
	delete pending.claimedAt;
	delete pending.claimantProcessIdentity;
	const serialized = JSON.stringify(pending);
	return withImmediateTransaction(db, () => {
		const currentAuthority = readRuntimeMailboxAuthoritySnapshot(db, recipient, candidate.row.session_path);
		if (!runtimeMailboxAuthoritySnapshotsEqual(candidate.authority, currentAuthority)) return false;
		return accepted
			? compareAndDeleteCanonicalMailboxPayload(db, candidate.row)
			: compareAndWriteSerializedCanonicalMailboxPayload(db, candidate.row, serialized, nowIso);
	});
}

export function readRuntimeMailboxAuthoritySnapshot(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	sessionPath: string,
): RuntimeMailboxAuthoritySnapshot {
	return {
		listener: readRuntimeMailboxListenerRow(db, recipient),
		ownership: recipient.agentId ? readMultiAgentRuntimeOwnershipRow(db, sessionPath, recipient.agentId) : undefined,
	};
}

export function currentRuntimeOwnsMailboxAuthority(
	recipient: RuntimeMailboxAddress,
	authority: RuntimeMailboxAuthoritySnapshot,
): boolean {
	if (
		authority.listener?.pid === process.pid &&
		authority.listener.runtime_instance_id === RUNTIME_PROCESS_INSTANCE_ID
	) {
		return true;
	}
	if (!recipient.agentId) return false;
	return persistedProcessIdentityIsCurrent(authority.ownership?.process_identity);
}

export function runtimeMailboxAuthoritySnapshotsEqual(
	expected: RuntimeMailboxAuthoritySnapshot,
	current: RuntimeMailboxAuthoritySnapshot,
): boolean {
	return (
		runtimeMailboxListenerRowsEqual(expected.listener, current.listener) &&
		multiAgentRuntimeOwnershipRowsEqual(expected.ownership, current.ownership)
	);
}

export function multiAgentRuntimeOwnershipRowsEqual(
	expected: MultiAgentRuntimeOwnershipRow | undefined,
	current: MultiAgentRuntimeOwnershipRow | undefined,
): boolean {
	if (!expected || !current) return expected === current;
	return (
		expected.session_path === current.session_path &&
		expected.agent_id === current.agent_id &&
		expected.process_identity === current.process_identity &&
		expected.owner_session_id === current.owner_session_id &&
		expected.owner_agent_id === current.owner_agent_id
	);
}

export function runtimeMailboxClaimantIsLive(claimantProcessIdentity: string): boolean {
	if (claimantProcessIdentity === RUNTIME_PROCESS_INSTANCE_ID) return true;
	const claimant = parseProcessIdentity(claimantProcessIdentity);
	const current = parseProcessIdentity(RUNTIME_PROCESS_INSTANCE_ID);
	if (isSupersededRuntimeIdentity(claimant, current)) return false;
	return persistedProcessIdentityIsLive(claimantProcessIdentity);
}

export function persistedProcessIdentityIsCurrent(value: string | null | undefined): boolean {
	if (!value) return false;
	try {
		const current = readProcessIdentity(process.pid);
		const persisted = parseProcessIdentity(value);
		return current.pid === persisted.pid && current.startTimeTicks === persisted.startTimeTicks;
	} catch {
		return false;
	}
}

export function persistedProcessIdentityIsLive(value: string): boolean {
	try {
		return isProcessIdentityAlive(parseProcessIdentity(value));
	} catch {
		return false;
	}
}

export function readCanonicalMailboxRowByStoreRef(
	db: SqliteDatabase,
	storeRef: RuntimeMailboxStoreRef,
): RuntimeMailboxRow | undefined {
	return db
		.prepare(
			`SELECT rowid AS id, session_path, message_id, data, updated_at
			 FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?
			 AND ${MAILBOX_CREATED_AT_MS_SQL} > ?`,
		)
		.get(storeRef.sessionPath, storeRef.messageId, Date.now() - MAILBOX_MESSAGE_RETENTION_MS) as
		| RuntimeMailboxRow
		| undefined;
}

export function parseCanonicalMailboxPayload(row: RuntimeMailboxRow): Record<string, unknown> {
	const context = `multi_agent_mailbox_messages:${row.session_path}#${row.message_id}`;
	const message = parseStoredJsonObject(row.data, context);
	validateMailboxPayload(message, context);
	return message;
}

export function compareAndWriteSerializedCanonicalMailboxPayload(
	db: SqliteDatabase,
	row: RuntimeMailboxRow,
	serialized: string,
	updatedAt: string,
): boolean {
	const updated = db
		.prepare(
			`UPDATE multi_agent_mailbox_messages SET data = ?, updated_at = ?
			 WHERE rowid = ? AND session_path = ? AND message_id = ? AND data = ? AND updated_at = ?
			 AND ${MAILBOX_CREATED_AT_MS_SQL} > ?`,
		)
		.run(
			serialized,
			updatedAt,
			row.id,
			row.session_path,
			row.message_id,
			row.data,
			row.updated_at,
			Date.now() - MAILBOX_MESSAGE_RETENTION_MS,
		);
	return updated.changes === 1;
}

export function compareAndDeleteCanonicalMailboxPayload(db: SqliteDatabase, row: RuntimeMailboxRow): boolean {
	return (
		db
			.prepare(
				`DELETE FROM multi_agent_mailbox_messages
		 WHERE rowid = ? AND session_path = ? AND message_id = ? AND data = ? AND updated_at = ?
		 AND ${MAILBOX_CREATED_AT_MS_SQL} > ?`,
			)
			.run(
				row.id,
				row.session_path,
				row.message_id,
				row.data,
				row.updated_at,
				Date.now() - MAILBOX_MESSAGE_RETENTION_MS,
			).changes === 1
	);
}

export function runtimeMailboxListenerRowsEqual(
	expected: RuntimeMailboxListenerRow | undefined,
	current: RuntimeMailboxListenerRow | undefined,
): boolean {
	if (!expected || !current) return expected === current;
	return (
		expected.pid === current.pid &&
		expected.runtime_instance_id === current.runtime_instance_id &&
		expected.session_path === current.session_path &&
		expected.session_path_asserted_at === current.session_path_asserted_at &&
		expected.updated_at === current.updated_at
	);
}

export function readRuntimeMailboxListenerRow(
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

export function notifyRuntimeMailboxListener(listener: RuntimeMailboxListenerRow | undefined): void {
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

export interface MultiAgentRuntimeOwnershipRow {
	session_path: string;
	agent_id: string;
	process_identity: string | null;
	owner_session_id: string | null;
	owner_agent_id: string | null;
}

export function readMultiAgentRuntimeOwnershipRow(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
): MultiAgentRuntimeOwnershipRow | undefined {
	return db
		.prepare("SELECT * FROM multi_agent_runtime_owners WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, agentId) as MultiAgentRuntimeOwnershipRow | undefined;
}

export function sameMailboxMessageIdentity(
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
