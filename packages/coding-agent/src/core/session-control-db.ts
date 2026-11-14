import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { getUserStateRoot } from "../config.ts";
import type { DetachedJobTerminalInput } from "./detached-job-runner.ts";
import { isMailboxMessageExpired, MAILBOX_MESSAGE_RETENTION_MS } from "./mailbox-retention.ts";
import {
	type AgentFileReference,
	type AgentMailboxMessage,
	type AgentSnapshot,
	isActiveLifecycle,
} from "./multi-agent-store.ts";
import { isSandboxProfileName, type SandboxProfileName } from "./permissions/presets.ts";
import type { RuntimeMailboxAcceptanceCheck } from "./runtime-mailbox-transcript.ts";
import {
	isPiRuntimeProcessAlive,
	isProcessIdentityAlive,
	isSupersededRuntimeIdentity,
	isVerifiedPiRuntimeProcess,
	type ProcessIdentity,
	readProcessIdentity,
} from "./runtime-process.ts";
import {
	addRuntimeMailboxRouting,
	assertRuntimeMailboxRouting,
	isNonterminalLifecycle,
	nullableStringField,
	optionalStringField,
	parseFileRefs,
	parseJsonObject,
	parseSteeringCheckpoint,
	parseStoredJsonObject,
	requireStringField,
	stripRuntimeMailboxDeliveryState,
	toRuntimeMailboxMessageKind,
	toRuntimeMailboxMessageStatus,
	validateMailboxPayload,
	validatePersistedAgentPayload,
} from "./session-control-db/codecs.ts";
import {
	parseProcessIdentity,
	TERMINAL_AGENT_ROW_TABLES,
	withImmediateTransaction,
} from "./session-control-db/helpers.ts";
import {
	type EnqueueRuntimeMailboxMessageInput,
	type EnqueueStoredRuntimeMailboxMessageInput,
	type IncomingControlMessage,
	type IncomingRow,
	MAILBOX_CREATED_AT_MS_SQL,
	type PostSharedChannelMessageInput,
	type RuntimeMailboxAddress,
	type RuntimeMailboxListedRow,
	type RuntimeMailboxListener,
	type RuntimeMailboxListenerRow,
	type RuntimeMailboxMessage,
	type RuntimeMailboxMessageStatus,
	type RuntimeMailboxRegistrationOptions,
	type RuntimeMailboxRow,
	type RuntimeMailboxStoreRef,
	type SharedChannelMessage,
} from "./session-control-db/types.ts";
import {
	emptySessionHealth,
	endSessionHealth,
	type SessionCheckStatus,
	type SessionHealthRecord,
} from "./session-health.ts";
import type { SqliteDatabase } from "./sqlite.ts";

export {
	prepareControlDbForSelfRestart,
	retainControlDbConnection,
	withControlDb,
} from "./session-control-db/connection.ts";
export { normalizeSessionName, withImmediateTransaction } from "./session-control-db/helpers.ts";

import { withControlDb } from "./session-control-db/connection.ts";

export {
	claimPendingArchitectRequests,
	completeArchitectRequest,
	listPendingArchitectRequests,
	postArchitectRequest,
	renewArchitectRequestClaims,
} from "./session-control-db/architect.ts";
export {
	readLastMessage,
	readOrMigratePromptHistory,
	readPromptHistory,
	recordPromptHistoryEntry,
	writeLastMessage,
} from "./session-control-db/incoming-history.ts";

export {
	cancelSupervisorRequest,
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	hasPendingSupervisorApprovalRequest,
	postSupervisorRequest,
	readSupervisorRequest,
	recoverSupervisorRequests,
	requeueSupervisorRequest,
} from "./session-control-db/supervisor.ts";

import { assertSessionMetadataIdentity } from "./session-control-db/session-metadata.ts";

export {
	clearSessionSandboxProfile,
	findActiveSessionMetadataById,
	findActiveSessionMetadataByName,
	listActiveSessionMetadata,
	listArchivedSessionMetadata,
	listEmptyMainSessionCandidates,
	listResumeSessionMetadata,
	listSessionMetadata,
	readSessionGoal,
	readSessionMetadata,
	writeSessionGoal,
	writeSessionMetadata,
	writeSessionModel,
	writeSessionSandboxProfile,
	writeSessionThinkingLevel,
} from "./session-control-db/session-metadata.ts";

export {
	listDescendantSessionPaths,
	listSubagentSessionPaths,
	readSessionNameState,
	relocateAndArchiveSession,
	relocateAndUnarchiveSession,
	relocateSessionControlData,
	removeDeletedSessionsControlData,
	removeSessionMetadata,
	removeSessionsMetadata,
	writeSessionName,
} from "./session-control-db/session-relocation.ts";

export type {
	ArchitectRequest,
	ArchitectRequestStatus,
	EnqueueRuntimeMailboxMessageInput,
	EnqueueStoredRuntimeMailboxMessageInput,
	IncomingControlMessage,
	LastControlMessage,
	PostArchitectRequestInput,
	PostSharedChannelMessageInput,
	PostSupervisorRequestInput,
	ResumeSessionMetadataOptions,
	RuntimeMailboxAddress,
	RuntimeMailboxListener,
	RuntimeMailboxMessage,
	RuntimeMailboxMessageKind,
	RuntimeMailboxMessageStatus,
	RuntimeMailboxRegistrationOptions,
	RuntimeMailboxStoreRef,
	SessionMetadata,
	SharedChannelMessage,
	SupervisorRequest,
	SupervisorRequestKind,
	SupervisorRequestStatus,
	SupervisorResponse,
	WritableSessionMetadata,
} from "./session-control-db/types.ts";

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
	origin_host: string | null;
	origin_id: number | null;
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

type SessionSandboxProfileRow = {
	profile: string;
	session_id: string;
};

export function getControlDbPath(directory = getUserStateRoot()): string {
	return join(directory, "control.sqlite");
}

/** Claims one recovery attempt per explicit request, independent of transcript ancestry. */
export function claimCodexRestrictionRecovery(controlDbPath: string, userRequestId: string): boolean {
	if (userRequestId.trim().length === 0) throw new Error("Codex restriction recovery request ID must not be empty");
	return withControlDb(controlDbPath, (db) => {
		const result = db
			.prepare(
				`
				INSERT INTO codex_restriction_recovery_claims (user_request_id, claimed_at)
				VALUES (?, ?)
				ON CONFLICT(user_request_id) DO NOTHING
				`,
			)
			.run(userRequestId, new Date().toISOString());
		return result.changes === 1;
	});
}

/** Queues a control message; a target session ID reserves it for that session, otherwise any session may claim it. */
export function enqueueIncomingMessage(controlDbPath: string, content: string, targetSessionId?: string): number {
	return withControlDb(controlDbPath, (db) => {
		const result = db
			.prepare(
				`
				INSERT INTO incoming_messages (content, status, created_at, target_session_id)
				VALUES (?, 'pending', ?, ?)
				`,
			)
			.run(content, new Date().toISOString(), targetSessionId ?? null);
		return Number(result.lastInsertRowid);
	});
}

/** The session a running Pi process serves, from its newest healthy session-health row. */
export function readRunningSessionIdByPid(controlDbPath: string, pid: number): string | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`
				SELECT session_id
				FROM session_health
				WHERE pid = ? AND check_status = 'ok'
				ORDER BY updated_at DESC
				LIMIT 1
				`,
			)
			.get(pid) as { session_id: string } | undefined;
		return row?.session_id;
	});
}

/**
 * Claims the newest pending message addressed to this session or to no session, and supersedes the other pending
 * messages this session could claim. Messages addressed to other sessions stay pending for them.
 */
export function claimLatestIncomingMessage(
	controlDbPath: string,
	sessionId: string,
): IncomingControlMessage | undefined {
	return withControlDb(controlDbPath, (db) => {
		if (!readLatestPendingIncomingMessage(db, sessionId)) return undefined;
		const nowIso = new Date().toISOString();
		return withImmediateTransaction(db, () => claimLatestIncomingMessageInTransaction(db, sessionId, nowIso));
	});
}

function claimLatestIncomingMessageInTransaction(
	db: SqliteDatabase,
	sessionId: string,
	now: string,
): IncomingControlMessage | undefined {
	const row = readLatestPendingIncomingMessage(db, sessionId);
	if (!row) return undefined;
	db.prepare(
		`
		UPDATE incoming_messages
		SET status = 'superseded', completed_at = ?
		WHERE status = 'pending' AND id <> ? AND (target_session_id = ? OR target_session_id IS NULL)
		`,
	).run(now, row.id, sessionId);
	db.prepare(
		`
		UPDATE incoming_messages
		SET status = 'claimed', claimed_at = ?
		WHERE id = ?
		`,
	).run(now, row.id);
	return { id: row.id, content: row.content };
}

function readLatestPendingIncomingMessage(db: SqliteDatabase, sessionId: string): IncomingRow | undefined {
	return db
		.prepare(
			`
			SELECT id, content, target_session_id
			FROM incoming_messages
			WHERE status = 'pending' AND (target_session_id = ? OR target_session_id IS NULL)
			ORDER BY id DESC
			LIMIT 1
			`,
		)
		.get(sessionId) as IncomingRow | undefined;
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

const RUNTIME_MAILBOX_ROUTING_MAX_ATTEMPTS = 3;

function assertMailboxMessageFresh(message: Record<string, unknown>, context: string): void {
	if (isMailboxMessageExpired(message.createdAt, Date.now())) {
		throw new Error(`Expired mailbox message at ${context}`);
	}
}

export function enqueueRuntimeMailboxMessage(controlDbPath: string, input: EnqueueRuntimeMailboxMessageInput): number {
	const result = withControlDb(controlDbPath, (db) => routeRuntimeMailboxMessage(db, input));
	if (!input.recipientHost || input.recipientHost === hostname()) notifyRuntimeMailboxListener(result.listener);
	return result.id;
}

function routeRuntimeMailboxMessage(db: SqliteDatabase, input: EnqueueRuntimeMailboxMessageInput) {
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

type PreparedStoredRuntimeMailboxMessage = {
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

export function isKnownLocalSession(controlDbPath: string, sessionId: string): boolean {
	return withControlDb(controlDbPath, (db) =>
		Boolean(
			db
				.prepare(
					"SELECT 1 FROM session_metadata WHERE id = ? UNION ALL SELECT 1 FROM session_health WHERE session_id = ? LIMIT 1",
				)
				.get(sessionId, sessionId),
		),
	);
}

function prepareStoredRuntimeMailboxMessage(
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

function persistStoredRuntimeMailboxMessage(
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

function validateExistingStoredRuntimeMailboxMessage(
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

type RuntimeMailboxAuthoritySnapshot = {
	listener: RuntimeMailboxListenerRow | undefined;
	ownership: MultiAgentRuntimeOwnershipRow | undefined;
};

type RuntimeMailboxCandidate = {
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

function readRecoverableRuntimeMailboxClaims(
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

function recoverRuntimeMailboxClaim(
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

export function takeRuntimeMailboxMessagesForDelivery(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	isEligible: (message: RuntimeMailboxMessage) => boolean,
	limit = 20,
): RuntimeMailboxMessage[] {
	return withControlDb(controlDbPath, (db) => {
		const candidates = readEligibleRuntimeMailboxDeliveryCandidates(db, recipient, isEligible);
		return deliverRuntimeMailboxCandidates(db, recipient, candidates, limit, new Date().toISOString());
	});
}

/** Reports whether an eligible pending message exists without delivering it. */
export function hasPendingRuntimeMailboxMessage(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	isEligible: (message: RuntimeMailboxMessage) => boolean,
): boolean {
	return withControlDb(
		controlDbPath,
		(db) => readEligibleRuntimeMailboxDeliveryCandidates(db, recipient, isEligible).length > 0,
	);
}

function readEligibleRuntimeMailboxDeliveryCandidates(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	isEligible: (message: RuntimeMailboxMessage) => boolean,
): RuntimeMailboxCandidate[] {
	const rows = readCanonicalMailboxRowsForRecipient(db, recipient, "pending", Number.MAX_SAFE_INTEGER);
	return rows.flatMap((row) => {
		const authority = readRuntimeMailboxAuthoritySnapshot(db, recipient, row.session_path);
		if (!currentRuntimeOwnsMailboxAuthority(recipient, authority)) return [];
		const data = parseCanonicalMailboxPayload(row);
		const message = runtimeMailboxMessageFromCanonicalRow(row, data);
		return isEligible(message) ? [{ authority, data, row }] : [];
	});
}

function deliverRuntimeMailboxCandidates(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	candidates: RuntimeMailboxCandidate[],
	limit: number,
	nowIso: string,
): RuntimeMailboxMessage[] {
	const deliveredMessages: RuntimeMailboxMessage[] = [];
	for (const candidate of candidates) {
		if (deliveredMessages.length === limit) break;
		const delivered = deliverRuntimeMailboxCandidate(db, recipient, candidate, nowIso);
		if (delivered) deliveredMessages.push(delivered);
	}
	return deliveredMessages;
}

function deliverRuntimeMailboxCandidate(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	candidate: RuntimeMailboxCandidate,
	nowIso: string,
): RuntimeMailboxMessage | undefined {
	if (candidate.data.kind === "steer" && candidate.authority.ownership) {
		return deliverRuntimeMailboxSteeringCandidate(db, recipient, candidate, nowIso);
	}
	return claimRuntimeMailboxCandidate(db, recipient, candidate, nowIso);
}

function deliverRuntimeMailboxSteeringCandidate(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	candidate: RuntimeMailboxCandidate,
	nowIso: string,
): RuntimeMailboxMessage | undefined {
	const ownership = candidate.authority.ownership;
	if (!ownership?.process_identity || !ownership.owner_session_id) return undefined;
	const input: CommitMultiAgentSteeringDeliveryInput = {
		agentId: ownership.agent_id,
		messageId: candidate.row.message_id,
		owner: { agentId: ownership.owner_agent_id, sessionId: ownership.owner_session_id },
		processIdentity: parseProcessIdentity(ownership.process_identity),
		requestedLifecycle: "running",
		sessionPath: candidate.row.session_path,
		updatedAt: nowIso,
	};
	const preflight = prepareMultiAgentSteeringDelivery(db, input);
	if ("result" in preflight || preflight.plan.messageData !== candidate.row.data) return undefined;
	const result = persistMultiAgentSteeringDelivery(db, input, preflight.plan, { recipient, candidate });
	return result?.ok
		? runtimeMailboxMessageFromCanonicalRow(candidate.row, {
				...candidate.data,
				status: "claimed",
				claimedAt: nowIso,
				updatedAt: nowIso,
			})
		: undefined;
}

function readRuntimeMailboxAuthoritySnapshot(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	sessionPath: string,
): RuntimeMailboxAuthoritySnapshot {
	return {
		listener: readRuntimeMailboxListenerRow(db, recipient),
		ownership: recipient.agentId ? readMultiAgentRuntimeOwnershipRow(db, sessionPath, recipient.agentId) : undefined,
	};
}

function currentRuntimeOwnsMailboxAuthority(
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

function runtimeMailboxAuthoritySnapshotsEqual(
	expected: RuntimeMailboxAuthoritySnapshot,
	current: RuntimeMailboxAuthoritySnapshot,
): boolean {
	return (
		runtimeMailboxListenerRowsEqual(expected.listener, current.listener) &&
		multiAgentRuntimeOwnershipRowsEqual(expected.ownership, current.ownership)
	);
}

function multiAgentRuntimeOwnershipRowsEqual(
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

export function claimRuntimeMailboxMessages(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	limit = 20,
): RuntimeMailboxMessage[] {
	return withControlDb(controlDbPath, (db) => {
		const candidates = readClaimableRuntimeMailboxCandidates(db, recipient, limit);
		return claimRuntimeMailboxCandidates(db, recipient, candidates, new Date().toISOString());
	});
}

function readClaimableRuntimeMailboxCandidates(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	limit: number,
): RuntimeMailboxCandidate[] {
	const rows = readCanonicalMailboxRowsForRecipient(db, recipient, "pending", limit);
	return rows.flatMap((row) => {
		const authority = readRuntimeMailboxAuthoritySnapshot(db, recipient, row.session_path);
		if (!currentRuntimeOwnsMailboxAuthority(recipient, authority)) return [];
		return [{ authority, data: parseCanonicalMailboxPayload(row), row }];
	});
}

function claimRuntimeMailboxCandidates(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	candidates: RuntimeMailboxCandidate[],
	nowIso: string,
): RuntimeMailboxMessage[] {
	return candidates.flatMap((candidate) => {
		const claimed = claimRuntimeMailboxCandidate(db, recipient, candidate, nowIso);
		return claimed ? [claimed] : [];
	});
}

function claimRuntimeMailboxCandidate(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	candidate: RuntimeMailboxCandidate,
	nowIso: string,
): RuntimeMailboxMessage | undefined {
	const claimed = {
		...candidate.data,
		claimedAt: nowIso,
		claimantProcessIdentity: RUNTIME_PROCESS_INSTANCE_ID,
		status: "claimed",
		updatedAt: nowIso,
	};
	const serialized = JSON.stringify(claimed);
	const updated = withImmediateTransaction(db, () => {
		const currentAuthority = readRuntimeMailboxAuthoritySnapshot(db, recipient, candidate.row.session_path);
		if (!runtimeMailboxAuthoritySnapshotsEqual(candidate.authority, currentAuthority)) return false;
		return compareAndWriteSerializedCanonicalMailboxPayload(db, candidate.row, serialized, nowIso);
	});
	return updated ? runtimeMailboxMessageFromCanonicalRow(candidate.row, claimed) : undefined;
}

function runtimeMailboxClaimantIsLive(claimantProcessIdentity: string): boolean {
	if (claimantProcessIdentity === RUNTIME_PROCESS_INSTANCE_ID) return true;
	const claimant = parseProcessIdentity(claimantProcessIdentity);
	const current = parseProcessIdentity(RUNTIME_PROCESS_INSTANCE_ID);
	if (isSupersededRuntimeIdentity(claimant, current)) return false;
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

function readCanonicalMailboxRowByStoreRef(
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

function readCanonicalMailboxRowById(db: SqliteDatabase, id: number): RuntimeMailboxRow | undefined {
	return db
		.prepare(
			`SELECT rowid AS id, session_path, message_id, data, updated_at
			 FROM multi_agent_mailbox_messages WHERE rowid = ? AND ${MAILBOX_CREATED_AT_MS_SQL} > ?`,
		)
		.get(id, Date.now() - MAILBOX_MESSAGE_RETENTION_MS) as RuntimeMailboxRow | undefined;
}

function parseCanonicalMailboxPayload(row: RuntimeMailboxRow): Record<string, unknown> {
	const context = `multi_agent_mailbox_messages:${row.session_path}#${row.message_id}`;
	const message = parseStoredJsonObject(row.data, context);
	validateMailboxPayload(message, context);
	return message;
}

function compareAndWriteSerializedCanonicalMailboxPayload(
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

function compareAndDeleteCanonicalMailboxPayload(db: SqliteDatabase, row: RuntimeMailboxRow): boolean {
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

export function deliverRuntimeMailboxMessage(controlDbPath: string, id: number, expectedPayloadData?: string): boolean {
	return withControlDb(controlDbPath, (db) => {
		const row = readCanonicalMailboxRowById(db, id);
		if (!row) return false;
		const message = parseCanonicalMailboxPayload(row);
		if (message.recipientHost && message.recipientHost !== hostname()) return false;
		if (message.status !== "claimed" || message.claimantProcessIdentity !== RUNTIME_PROCESS_INSTANCE_ID) return false;
		if (expectedPayloadData !== undefined && row.data !== expectedPayloadData) return false;
		return withImmediateTransaction(db, () => compareAndDeleteCanonicalMailboxPayload(db, row));
	});
}

function updateClaimedCanonicalMailboxMessage(
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

function updateClaimedCanonicalMailboxMessageRow(
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

export function consumeRuntimeMailboxMessageByStoreRef(
	controlDbPath: string,
	storeRef: RuntimeMailboxStoreRef,
): number {
	return withControlDb(controlDbPath, (db) => {
		const row = readCanonicalMailboxRowByStoreRef(db, storeRef);
		if (!row) return 0;
		const host = parseCanonicalMailboxPayload(row).recipientHost;
		if (host && host !== hostname()) return 0;
		return Number(withImmediateTransaction(db, () => compareAndDeleteCanonicalMailboxPayload(db, row)));
	});
}

const RUNTIME_MAILBOX_REGISTRATION_MAX_ATTEMPTS = 3;

type RuntimeMailboxRegistration = {
	options: RuntimeMailboxRegistrationOptions;
	pid: number;
	recipient: RuntimeMailboxAddress;
	runtimeInstanceId: string;
	sessionPath: string | undefined;
};

type RuntimeMailboxRegistrationSnapshot = {
	health: SessionHealthRecord | undefined;
	listener: RuntimeMailboxListenerRow | undefined;
};

type RuntimeMailboxRegistrationPlan = {
	nowIso: string;
	shouldReconcileReplacement: boolean;
	snapshot: RuntimeMailboxRegistrationSnapshot;
};

export function registerRuntimeMailboxListener(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	pid: number,
	sessionPath?: string,
	options: RuntimeMailboxRegistrationOptions = {},
): void {
	const registration: RuntimeMailboxRegistration = {
		options,
		pid,
		recipient,
		runtimeInstanceId: options.runtimeInstanceId ?? RUNTIME_PROCESS_INSTANCE_ID,
		sessionPath,
	};
	withControlDb(controlDbPath, (db) => registerRuntimeMailboxListenerWithDb(db, registration));
	const ownsRegistration = pid === process.pid && registration.runtimeInstanceId === RUNTIME_PROCESS_INSTANCE_ID;
	if (ownsRegistration && options.isMailboxStoreRefAccepted) {
		recoverDeadRuntimeMailboxClaims(controlDbPath, recipient, options.isMailboxStoreRefAccepted);
	}
}

function registerRuntimeMailboxListenerWithDb(db: SqliteDatabase, registration: RuntimeMailboxRegistration): void {
	for (let attempt = 1; attempt <= RUNTIME_MAILBOX_REGISTRATION_MAX_ATTEMPTS; attempt += 1) {
		const plan = prepareRuntimeMailboxRegistration(db, registration);
		if (commitRuntimeMailboxRegistration(db, registration, plan)) return;
	}
	throw new Error(
		`Runtime mailbox listener changed repeatedly while registering session ${registration.recipient.sessionId}`,
	);
}

function prepareRuntimeMailboxRegistration(
	db: SqliteDatabase,
	registration: RuntimeMailboxRegistration,
): RuntimeMailboxRegistrationPlan {
	const snapshot = readRuntimeMailboxRegistrationSnapshot(db, registration.recipient);
	const runtimeOwnerChanged =
		snapshot.listener?.pid !== registration.pid ||
		snapshot.listener?.runtime_instance_id !== registration.runtimeInstanceId;
	const shouldReconcileReplacement =
		registration.recipient.agentId === null &&
		registration.options.reconcileRuntimeReplacement !== false &&
		runtimeOwnerChanged;
	if (shouldReconcileReplacement) assertRuntimeReplacementAllowed(db, registration, snapshot);
	return { nowIso: new Date().toISOString(), shouldReconcileReplacement, snapshot };
}

function commitRuntimeMailboxRegistration(
	db: SqliteDatabase,
	registration: RuntimeMailboxRegistration,
	plan: RuntimeMailboxRegistrationPlan,
): boolean {
	return withImmediateTransaction(db, () => {
		const current = readRuntimeMailboxRegistrationSnapshot(db, registration.recipient);
		if (!runtimeMailboxRegistrationSnapshotsEqual(plan.snapshot, current)) return false;
		registerRuntimeMailboxListenerInTransaction(db, registration, plan.nowIso, plan.shouldReconcileReplacement);
		return true;
	});
}

function readRuntimeMailboxRegistrationSnapshot(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
): RuntimeMailboxRegistrationSnapshot {
	return {
		health: recipient.agentId === null ? readSessionHealthRow(db, recipient.sessionId) : undefined,
		listener: readRuntimeMailboxListenerRow(db, recipient),
	};
}

function runtimeMailboxRegistrationSnapshotsEqual(
	expected: RuntimeMailboxRegistrationSnapshot,
	current: RuntimeMailboxRegistrationSnapshot,
): boolean {
	return (
		runtimeMailboxListenerRowsEqual(expected.listener, current.listener) &&
		sessionHealthRowsEqual(expected.health, current.health)
	);
}

function runtimeMailboxListenerRowsEqual(
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

function sessionHealthRowsEqual(
	expected: SessionHealthRecord | undefined,
	current: SessionHealthRecord | undefined,
): boolean {
	if (!expected || !current) return expected === current;
	return (
		expected.sessionId === current.sessionId &&
		expected.agentGeneration === current.agentGeneration &&
		expected.pid === current.pid &&
		expected.lastActiveAt === current.lastActiveAt &&
		expected.lastCheckedAt === current.lastCheckedAt &&
		expected.checkStatus === current.checkStatus &&
		expected.checkedGeneration === current.checkedGeneration &&
		expected.checkLatencyMs === current.checkLatencyMs &&
		expected.updatedAt === current.updatedAt
	);
}

function registerRuntimeMailboxListenerInTransaction(
	db: SqliteDatabase,
	registration: RuntimeMailboxRegistration,
	nowIso: string,
	shouldReconcileReplacement: boolean,
): void {
	const { pid, recipient, runtimeInstanceId, sessionPath } = registration;
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
	registration: RuntimeMailboxRegistration,
	snapshot: RuntimeMailboxRegistrationSnapshot,
): void {
	const existingListener = snapshot.listener;
	const existingOwnerPid = existingListener?.pid ?? snapshot.health?.pid;
	if (existingOwnerPid === null || existingOwnerPid === undefined) return;
	if (existingListener?.runtime_instance_id === registration.runtimeInstanceId) return;
	if (existingListener?.runtime_instance_id) {
		try {
			if (!isProcessIdentityAlive(parseProcessIdentity(existingListener.runtime_instance_id))) return;
		} catch {
			if (existingOwnerPid === registration.pid) return;
		}
	}
	const isRuntimeProcessAlive = registration.options.isRuntimeProcessAlive ?? isPiRuntimeProcessAlive;
	if (!isRuntimeProcessAlive(existingOwnerPid)) return;
	const sessionId = registration.recipient.sessionId;
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
	const nowIso = new Date().toISOString();
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => retireRuntimeMailboxListenerRow(db, recipient, pid, nowIso)),
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

function retireSupersededMainRuntimeMailboxListeners(
	db: SqliteDatabase,
	currentSessionId: string,
	pid: number,
	nowIso: string,
): void {
	const supersededListeners = db
		.prepare(
			`
			DELETE FROM runtime_mailbox_listeners
			WHERE recipient_agent_id_key = ''
				AND pid = ?
				AND recipient_session_id <> ?
			RETURNING recipient_session_id
			`,
		)
		.all(pid, currentSessionId) as Array<{ recipient_session_id: string }>;
	for (const listener of supersededListeners) {
		retireSessionHealthForListener(db, listener.recipient_session_id, pid, nowIso);
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

export function readLiveRuntimeMailboxSessionAgentIds(controlDbPath: string, sessionId: string): Array<string | null> {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`SELECT recipient_agent_id_key, runtime_instance_id
				 FROM runtime_mailbox_listeners
				 WHERE recipient_session_id = ?`,
			)
			.all(sessionId) as Array<Pick<RuntimeMailboxListedRow, "recipient_agent_id_key" | "runtime_instance_id">>;
		return rows.flatMap((row) => {
			if (!row.runtime_instance_id || !runtimeMailboxClaimantIsLive(row.runtime_instance_id)) return [];
			return [row.recipient_agent_id_key === "" ? null : row.recipient_agent_id_key];
		});
	});
}

export function assertMainSessionRuntimeAvailable(controlDbPath: string, sessionId: string): void {
	withControlDb(controlDbPath, (db) => {
		const registration: RuntimeMailboxRegistration = {
			options: {},
			pid: process.pid,
			recipient: { agentId: null, sessionId },
			runtimeInstanceId: RUNTIME_PROCESS_INSTANCE_ID,
			sessionPath: undefined,
		};
		const snapshot = readRuntimeMailboxRegistrationSnapshot(db, registration.recipient);
		assertRuntimeReplacementAllowed(db, registration, snapshot);
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
				SELECT id, sender_session_id, sender_agent_id, body, created_at, origin_host, origin_id
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
					AND sender_agent_id IS NULL
					AND (origin_host IS NOT NULL OR sender_session_id <> ?)
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
		...(row.origin_host ? { originHost: row.origin_host, originId: row.origin_id ?? undefined } : {}),
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

function listRuntimeMailboxMessagesBySessionPath(controlDbPath: string, sessionPath?: string): RuntimeMailboxMessage[] {
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

export function readSessionSandboxProfile(
	controlDbPath: string,
	sessionPath: string,
	sessionId: string,
): SandboxProfileName | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare("SELECT session_id, profile FROM session_sandbox_profiles WHERE session_path = ?")
			.get(sessionPath) as SessionSandboxProfileRow | undefined;
		if (!row) return undefined;
		assertSessionMetadataIdentity(db, sessionPath, sessionId);
		if (row.session_id !== sessionId) {
			throw new Error(
				`Session identity mismatch for ${sessionPath}: stored ${row.session_id}, received ${sessionId}`,
			);
		}
		if (!isSandboxProfileName(row.profile)) {
			throw new Error(`Invalid sandbox profile '${row.profile}' for session ${sessionId}`);
		}
		return row.profile;
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
		const rows = db
			.prepare(
				`SELECT session_path, modified_at
				 FROM session_metadata
				 WHERE archived_at IS NULL AND is_subagent = 0 AND modified_at < ?`,
			)
			.all(cutoff.toISOString()) as Array<{ modified_at: string; session_path: string }>;
		return rows.sort(compareArchivedSessionRows).map((row) => row.session_path);
	});
}

function compareArchivedSessionRows(
	left: { modified_at: string; session_path: string },
	right: { modified_at: string; session_path: string },
): number {
	if (left.modified_at !== right.modified_at) return left.modified_at < right.modified_at ? -1 : 1;
	if (left.session_path === right.session_path) return 0;
	return left.session_path < right.session_path ? -1 : 1;
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
	status: "claimed" | "pending" | "poisoned";
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
	detachedCancellation?: {
		outputLabel: string;
		reason?: string;
		suppressTerminalNotification?: boolean;
	};
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

export interface DetachedArtifactAgentRecord {
	sessionPath: string;
	agent: AgentSnapshot;
}

export function claimMultiAgentTerminalOutbox(
	controlDbPath: string,
	claimId: string,
	nowIso: string,
	options: ClaimMultiAgentTerminalOutboxOptions = {},
): MultiAgentTerminalOutboxRecord | undefined {
	const maxAttempts = options.maxAttempts ?? 5;
	return withControlDb(controlDbPath, (db) => {
		if (!hasEligibleTerminalOutboxWork(db, maxAttempts, options)) return undefined;
		const row = withImmediateTransaction(db, () => {
			if (options.staleClaimBefore) {
				recoverStaleTerminalOutboxClaims(db, {
					maxAttempts,
					nowIso,
					sessionPath: options.sessionPath,
					staleClaimBefore: options.staleClaimBefore,
				});
			}
			return claimNextTerminalOutboxRow(db, claimId, nowIso, maxAttempts, options.sessionPath);
		});
		return row ? terminalOutboxRecordFromClaimedRow(row, claimId) : undefined;
	});
}

function hasEligibleTerminalOutboxWork(
	db: SqliteDatabase,
	maxAttempts: number,
	options: ClaimMultiAgentTerminalOutboxOptions,
): boolean {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM multi_agent_terminal_outbox
				 WHERE (? IS NULL OR session_path = ?)
				 AND (
					(status = 'pending' AND attempt_count < ?)
					OR (? IS NOT NULL AND status = 'claimed' AND claimed_at < ?)
				 )
				 LIMIT 1`,
			)
			.get(
				options.sessionPath ?? null,
				options.sessionPath ?? null,
				maxAttempts,
				options.staleClaimBefore ?? null,
				options.staleClaimBefore ?? null,
			),
	);
}

type RecoverStaleTerminalOutboxClaimsInput = {
	maxAttempts: number;
	nowIso: string;
	sessionPath?: string;
	staleClaimBefore: string;
};

function recoverStaleTerminalOutboxClaims(db: SqliteDatabase, input: RecoverStaleTerminalOutboxClaimsInput): void {
	db.prepare(
		`UPDATE multi_agent_terminal_outbox
		 SET status = CASE WHEN attempt_count >= ? THEN 'poisoned' ELSE 'pending' END,
		 claim_id = NULL, claimed_at = NULL, last_error = 'claim lease expired', updated_at = ?
		 WHERE status = 'claimed' AND claimed_at < ? AND (? IS NULL OR session_path = ?)`,
	).run(input.maxAttempts, input.nowIso, input.staleClaimBefore, input.sessionPath ?? null, input.sessionPath ?? null);
}

type ClaimedTerminalOutboxRow = {
	agent_id: string;
	attempt_count: number;
	event_kind: string;
	session_path: string;
	terminal_revision: number;
};

function claimNextTerminalOutboxRow(
	db: SqliteDatabase,
	claimId: string,
	nowIso: string,
	maxAttempts: number,
	sessionPath?: string,
): ClaimedTerminalOutboxRow | undefined {
	return db
		.prepare(
			`UPDATE multi_agent_terminal_outbox
			 SET status = 'claimed', claim_id = ?, claimed_at = ?,
			 attempt_count = attempt_count + 1, updated_at = ?
			 WHERE rowid = (
				SELECT rowid FROM multi_agent_terminal_outbox
				WHERE status = 'pending' AND attempt_count < ? AND (? IS NULL OR session_path = ?)
				ORDER BY updated_at LIMIT 1
			 )
			 AND status = 'pending'
			 RETURNING session_path, agent_id, terminal_revision, event_kind, attempt_count`,
		)
		.get(claimId, nowIso, nowIso, maxAttempts, sessionPath ?? null, sessionPath ?? null) as
		| ClaimedTerminalOutboxRow
		| undefined;
}

function terminalOutboxRecordFromClaimedRow(
	row: ClaimedTerminalOutboxRow,
	claimId: string,
): MultiAgentTerminalOutboxRecord {
	return {
		agentId: row.agent_id,
		attemptCount: row.attempt_count,
		claimId,
		eventKind: row.event_kind,
		sessionPath: row.session_path,
		status: "claimed",
		terminalRevision: row.terminal_revision,
	};
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
): boolean {
	return withControlDb(
		controlDbPath,
		(db) =>
			db
				.prepare(
					`DELETE FROM multi_agent_terminal_outbox
				 WHERE session_path = ? AND agent_id = ? AND terminal_revision = ? AND event_kind = ?
				 AND status = 'claimed' AND claim_id = ?`,
				)
				.run(record.sessionPath, record.agentId, record.terminalRevision, record.eventKind, record.claimId ?? null)
				.changes === 1,
	);
}

function updateClaimedTerminalOutbox(
	controlDbPath: string,
	record: MultiAgentTerminalOutboxRecord,
	status: "pending" | "poisoned",
	nowIso: string,
	error?: string,
): boolean {
	return withControlDb(
		controlDbPath,
		(db) =>
			db
				.prepare(
					`UPDATE multi_agent_terminal_outbox SET status = ?, claim_id = NULL, claimed_at = NULL, last_error = ?, updated_at = ? WHERE session_path = ? AND agent_id = ? AND terminal_revision = ? AND event_kind = ? AND status = 'claimed' AND claim_id = ?`,
				)
				.run(
					status,
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
					 WHERE status = 'poisoned' AND updated_at < ?`,
				)
				.run(olderThan).changes,
	);
}

const MULTI_AGENT_STEERING_MUTATION_MAX_ATTEMPTS = 3;

type MultiAgentSteeringMutationPlan = {
	agentData: string;
	mailbox: PreparedSteeringMailboxMessage;
	processIdentityData: string;
	recipientListener: RuntimeMailboxListenerRow;
	senderListener: RuntimeMailboxListenerRow;
	updatedAgent: AgentSnapshot;
	updatedAgentData: string;
};

type MultiAgentSteeringMutationPreflight =
	| { plan: MultiAgentSteeringMutationPlan }
	| { result: CommitMultiAgentSteeringMutationResult };

const STEERING_MESSAGE_ID_PLACEHOLDER = "__pi_generated_steering_message_id__";

type PreparedSteeringMailboxMessage = {
	dataPrefix: string;
	dataSuffix: string;
	updatedAt: string;
};

export function commitMultiAgentSteeringMutation(
	controlDbPath: string,
	input: CommitMultiAgentSteeringMutationInput,
): CommitMultiAgentSteeringMutationResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_STEERING_MUTATION_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareMultiAgentSteeringMutation(db, input);
			if ("result" in preflight) return preflight.result;
			const result = persistMultiAgentSteeringMutation(db, input, preflight.plan);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

function prepareMultiAgentSteeringMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringMutationInput,
): MultiAgentSteeringMutationPreflight {
	const agentRow = readSteeringMutationAgent(db, input);
	if (!agentRow) return { result: { ok: false, error: "agent_not_found" } };
	if (
		input.requestedLifecycle !== "steering_pending" ||
		!canPersistLifecycleTransition(agentRow.agent.lifecycle, input.requestedLifecycle)
	) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	const senderListener = readRuntimeMailboxListenerRow(db, {
		agentId: input.owner.agentId,
		sessionId: input.owner.sessionId,
	});
	const recipientListener = readRuntimeMailboxListenerRow(db, input.recipient);
	if (!senderListener || !recipientListener) return { result: { ok: false, error: "mutation_mismatch" } };
	if (!steeringMutationHasAuthority(agentRow.agent, ownership, senderListener, recipientListener, input)) {
		return { result: { ok: false, error: "mutation_mismatch" } };
	}
	const updatedAgent: AgentSnapshot = {
		...agentRow.agent,
		lifecycle: input.requestedLifecycle,
		revision: agentRow.agent.revision + 1,
		updatedAt: input.updatedAt,
	};
	return {
		plan: {
			agentData: agentRow.data,
			mailbox: prepareSteeringMailboxMessage(input),
			processIdentityData: serializeProcessIdentity(input.processIdentity),
			recipientListener,
			senderListener,
			updatedAgent,
			updatedAgentData: JSON.stringify(updatedAgent),
		},
	};
}

function readSteeringMutationAgent(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringMutationInput,
): { agent: AgentSnapshot; data: string } | undefined {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.agentId) as { data: string } | undefined;
	if (!row) return undefined;
	const context = `multi_agent_agents:${input.sessionPath}#${input.agentId}`;
	const agent = parseStoredJsonObject(row.data, context);
	validatePersistedAgentPayload(agent, context);
	return { agent: agent as unknown as AgentSnapshot, data: row.data };
}

function steeringMutationHasAuthority(
	agent: AgentSnapshot,
	ownership: MultiAgentRuntimeOwnershipRow | undefined,
	senderListener: RuntimeMailboxListenerRow,
	recipientListener: RuntimeMailboxListenerRow,
	input: CommitMultiAgentSteeringMutationInput,
): boolean {
	if (!runtimeOwnerMatches(ownership, input)) return false;
	const senderPathMatches =
		input.owner.agentId !== null || trustedRuntimeMailboxSessionPath(senderListener) === input.sessionPath;
	const expectedSenderId = input.owner.agentId ?? "supervisor";
	return (
		input.fromAgentId === expectedSenderId &&
		agent.parentId === (input.owner.agentId ?? "main") &&
		input.recipient.agentId === input.agentId &&
		input.recipient.sessionId === agent.transcript?.sessionId &&
		senderListener.pid === process.pid &&
		senderListener.runtime_instance_id === RUNTIME_PROCESS_INSTANCE_ID &&
		senderPathMatches &&
		runtimeListenerMatchesProcessIdentity(recipientListener, ownership?.process_identity)
	);
}

function persistMultiAgentSteeringMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringMutationInput,
	plan: MultiAgentSteeringMutationPlan,
): CommitMultiAgentSteeringMutationResult | undefined {
	const messageNumber = withImmediateTransaction(db, () => {
		if (!compareAndPersistSteeringAgent(db, input, plan)) return undefined;
		const allocatedMessageNumber = allocateMultiAgentCounterWithDb(db, input.sessionPath, "message");
		const messageId = `message_${allocatedMessageNumber}`;
		persistPreparedSteeringMailboxMessage(db, input.sessionPath, messageId, plan.mailbox);
		return allocatedMessageNumber;
	});
	if (messageNumber === undefined) return undefined;
	return {
		agent: plan.updatedAgent,
		message: buildSteeringMailboxMessage(input, `message_${messageNumber}`),
		ok: true,
	};
}

function compareAndPersistSteeringAgent(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringMutationInput,
	plan: MultiAgentSteeringMutationPlan,
): boolean {
	return (
		db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ?
				 AND EXISTS (
					SELECT 1 FROM multi_agent_runtime_owners
					WHERE session_path = ? AND agent_id = ? AND process_identity = ?
					AND owner_session_id = ? AND owner_agent_id IS ?
				 )
				 AND EXISTS (
					SELECT 1 FROM runtime_mailbox_listeners
					WHERE recipient_session_id = ? AND recipient_agent_id_key = ? AND pid = ?
					AND runtime_instance_id IS ? AND session_path IS ?
					AND session_path_asserted_at IS ? AND updated_at = ?
				 )
				 AND EXISTS (
					SELECT 1 FROM runtime_mailbox_listeners
					WHERE recipient_session_id = ? AND recipient_agent_id_key = ? AND pid = ?
					AND runtime_instance_id IS ? AND session_path IS ?
					AND session_path_asserted_at IS ? AND updated_at = ?
				 )`,
			)
			.run(
				plan.updatedAgentData,
				input.updatedAt,
				input.sessionPath,
				input.agentId,
				plan.agentData,
				input.sessionPath,
				input.agentId,
				plan.processIdentityData,
				input.owner.sessionId,
				input.owner.agentId,
				input.owner.sessionId,
				input.owner.agentId ?? "",
				plan.senderListener.pid,
				plan.senderListener.runtime_instance_id,
				plan.senderListener.session_path,
				plan.senderListener.session_path_asserted_at,
				plan.senderListener.updated_at,
				input.recipient.sessionId,
				input.recipient.agentId ?? "",
				plan.recipientListener.pid,
				plan.recipientListener.runtime_instance_id,
				plan.recipientListener.session_path,
				plan.recipientListener.session_path_asserted_at,
				plan.recipientListener.updated_at,
			).changes === 1
	);
}

function buildSteeringMailboxMessage(
	input: CommitMultiAgentSteeringMutationInput,
	messageId: string,
): AgentMailboxMessage {
	return {
		body: input.body,
		createdAt: input.updatedAt,
		fileRefs: input.fileRefs,
		fromAgentId: input.fromAgentId,
		id: messageId,
		kind: "steer",
		status: "pending",
		targetCheckpoint: input.targetCheckpoint,
		threadId: input.threadId,
		toAgentId: input.agentId,
		updatedAt: input.updatedAt,
	};
}

function prepareSteeringMailboxMessage(input: CommitMultiAgentSteeringMutationInput): PreparedSteeringMailboxMessage {
	const message = buildSteeringMailboxMessage(input, STEERING_MESSAGE_ID_PLACEHOLDER);
	const mailboxInput: EnqueueStoredRuntimeMailboxMessageInput = {
		kind: message.kind,
		message,
		recipient: input.recipient,
		sender: input.owner,
		storeRef: { messageId: message.id, sessionPath: input.sessionPath },
		updatedAt: input.updatedAt,
	};
	const serialized = prepareStoredRuntimeMailboxMessage(mailboxInput).serialized;
	const serializedId = JSON.stringify(STEERING_MESSAGE_ID_PLACEHOLDER);
	const idProperty = `"id":${serializedId}`;
	const idPropertyIndex = serialized.indexOf(idProperty);
	if (idPropertyIndex < 0 || serialized.indexOf(idProperty, idPropertyIndex + idProperty.length) >= 0) {
		throw new Error("Prepared steering mailbox payload has an invalid generated message ID field");
	}
	const serializedIdIndex = idPropertyIndex + `"id":`.length;
	return {
		dataPrefix: serialized.slice(0, serializedIdIndex),
		dataSuffix: serialized.slice(serializedIdIndex + serializedId.length),
		updatedAt: input.updatedAt,
	};
}

function persistPreparedSteeringMailboxMessage(
	db: SqliteDatabase,
	sessionPath: string,
	messageId: string,
	prepared: PreparedSteeringMailboxMessage,
): void {
	assertMailboxMessageFresh(
		{ createdAt: prepared.updatedAt },
		`multi_agent_mailbox_messages:${sessionPath}#${messageId}`,
	);
	db.prepare(
		`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
		 VALUES (?, ?, ? || json_quote(?) || ?, ?)`,
	).run(sessionPath, messageId, prepared.dataPrefix, messageId, prepared.dataSuffix, prepared.updatedAt);
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

const MULTI_AGENT_DETACH_MARK_MAX_ATTEMPTS = 3;

type MultiAgentDetachMarkPreflight =
	| { plan: { agentData: string; updatedAgent: AgentSnapshot } }
	| { result: CommitMultiAgentDetachMarkResult };

/**
 * Mark an owned background job as detached from its waiting tool call.
 * Only detached jobs emit a terminal runtime-mailbox notification; attended
 * jobs deliver their result in-band through the waiting tool call.
 */
export function commitMultiAgentDetachMark(
	controlDbPath: string,
	input: CommitMultiAgentDetachMarkInput,
): CommitMultiAgentDetachMarkResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_DETACH_MARK_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareMultiAgentDetachMark(db, input);
			if ("result" in preflight) return preflight.result;
			if (compareAndPersistMultiAgentDetachMark(db, input, preflight.plan)) {
				return { agent: preflight.plan.updatedAgent, ok: true };
			}
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

function prepareMultiAgentDetachMark(
	db: SqliteDatabase,
	input: CommitMultiAgentDetachMarkInput,
): MultiAgentDetachMarkPreflight {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.agentId) as { data: string } | undefined;
	if (!row) return { result: { ok: false, error: "agent_not_found" } };
	const context = `multi_agent_agents:${input.sessionPath}#${input.agentId}`;
	const agent = parseStoredJsonObject(row.data, context);
	validatePersistedAgentPayload(agent, context);
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	if (!runtimeOwnerMatches(ownership, input)) return { result: { ok: false, error: "mutation_mismatch" } };
	if (!isRecoverableRuntimeLifecycle(agent.lifecycle)) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	if (agent.detached === true) {
		return { result: { ok: true, agent: agent as unknown as AgentSnapshot } };
	}
	const updatedAgent = {
		...agent,
		detached: true,
		revision: Number(agent.revision) + 1,
		updatedAt: input.updatedAt,
	};
	validatePersistedAgentPayload(updatedAgent, context);
	return { plan: { agentData: row.data, updatedAgent: updatedAgent as unknown as AgentSnapshot } };
}

function compareAndPersistMultiAgentDetachMark(
	db: SqliteDatabase,
	input: CommitMultiAgentDetachMarkInput,
	plan: { agentData: string; updatedAgent: AgentSnapshot },
): boolean {
	return (
		db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ?
				 AND EXISTS (
					SELECT 1 FROM multi_agent_runtime_owners
					WHERE session_path = ? AND agent_id = ? AND process_identity = ?
					AND owner_session_id = ? AND owner_agent_id IS ?
				 )`,
			)
			.run(
				JSON.stringify(plan.updatedAgent),
				input.updatedAt,
				input.sessionPath,
				input.agentId,
				plan.agentData,
				input.sessionPath,
				input.agentId,
				serializeProcessIdentity(input.processIdentity),
				input.owner.sessionId,
				input.owner.agentId,
			).changes === 1
	);
}

const MULTI_AGENT_STEERING_DELIVERY_MAX_ATTEMPTS = 3;

type MultiAgentSteeringDeliveryPlan = {
	agentData: string;
	messageData: string;
	processIdentityData: string;
	updatedAgent: AgentSnapshot;
	updatedAgentData: string;
	updatedMessage: AgentMailboxMessage;
};

type MultiAgentSteeringDeliveryPreflight =
	| { plan: MultiAgentSteeringDeliveryPlan }
	| { result: CommitMultiAgentSteeringDeliveryResult };

export function commitMultiAgentSteeringDelivery(
	controlDbPath: string,
	input: CommitMultiAgentSteeringDeliveryInput,
): CommitMultiAgentSteeringDeliveryResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_STEERING_DELIVERY_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareMultiAgentSteeringDelivery(db, input);
			if ("result" in preflight) return preflight.result;
			const result = persistMultiAgentSteeringDelivery(db, input, preflight.plan);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

function prepareMultiAgentSteeringDelivery(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringDeliveryInput,
): MultiAgentSteeringDeliveryPreflight {
	const agentRow = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.agentId) as { data: string } | undefined;
	if (!agentRow) return { result: { ok: false, error: "agent_not_found" } };
	const agentContext = `multi_agent_agents:${input.sessionPath}#${input.agentId}`;
	const agent = parseStoredJsonObject(agentRow.data, agentContext);
	validatePersistedAgentPayload(agent, agentContext);
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	if (!runtimeOwnerMatches(ownership, input)) {
		return { result: { ok: false, error: "mutation_mismatch" } };
	}
	if (!canPersistLifecycleTransition(agent.lifecycle, input.requestedLifecycle)) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	const messageRow = db
		.prepare(`SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?
			AND ${MAILBOX_CREATED_AT_MS_SQL} > ?`)
		.get(input.sessionPath, input.messageId, Date.now() - MAILBOX_MESSAGE_RETENTION_MS) as
		| { data: string }
		| undefined;
	if (!messageRow) return { result: { ok: false, error: "message_not_found" } };
	const messageContext = `multi_agent_mailbox_messages:${input.sessionPath}#${input.messageId}`;
	const message = parseStoredJsonObject(messageRow.data, messageContext);
	validateMailboxPayload(message, messageContext);
	if (message.kind !== "steer" || message.toAgentId !== input.agentId) {
		return { result: { ok: false, error: "message_not_found" } };
	}
	const updatedAgent = {
		...agent,
		lifecycle: input.requestedLifecycle,
		revision: Number(agent.revision) + 1,
		updatedAt: input.updatedAt,
	} as unknown as AgentSnapshot;
	const updatedMessage = message as unknown as AgentMailboxMessage;
	return {
		plan: {
			agentData: agentRow.data,
			messageData: messageRow.data,
			processIdentityData: serializeProcessIdentity(input.processIdentity),
			updatedAgent,
			updatedAgentData: JSON.stringify(updatedAgent),
			updatedMessage,
		},
	};
}

function persistMultiAgentSteeringDelivery(
	db: SqliteDatabase,
	input: CommitMultiAgentSteeringDeliveryInput,
	plan: MultiAgentSteeringDeliveryPlan,
	mailbox?: { recipient: RuntimeMailboxAddress; candidate: RuntimeMailboxCandidate },
): CommitMultiAgentSteeringDeliveryResult | undefined {
	const claimedPayload = mailbox
		? JSON.stringify({
				...mailbox.candidate.data,
				status: "claimed",
				claimedAt: input.updatedAt,
				claimantProcessIdentity: RUNTIME_PROCESS_INSTANCE_ID,
				updatedAt: input.updatedAt,
			})
		: undefined;
	const persisted = withImmediateTransaction(db, () => {
		if (isMailboxMessageExpired(plan.updatedMessage.createdAt, Date.now())) return false;
		if (mailbox) {
			const authority = readRuntimeMailboxAuthoritySnapshot(db, mailbox.recipient, input.sessionPath);
			if (!runtimeMailboxAuthoritySnapshotsEqual(mailbox.candidate.authority, authority)) return false;
		}
		const agentUpdated = db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ?
				 AND EXISTS (
					SELECT 1 FROM multi_agent_runtime_owners
					WHERE session_path = ? AND agent_id = ? AND process_identity = ?
					AND owner_session_id = ? AND owner_agent_id IS ?
				 )
				 AND EXISTS (
					SELECT 1 FROM multi_agent_mailbox_messages
					WHERE session_path = ? AND message_id = ? AND data = ?
				 )`,
			)
			.run(
				plan.updatedAgentData,
				input.updatedAt,
				input.sessionPath,
				input.agentId,
				plan.agentData,
				input.sessionPath,
				input.agentId,
				plan.processIdentityData,
				input.owner.sessionId,
				input.owner.agentId,
				input.sessionPath,
				input.messageId,
				plan.messageData,
			).changes;
		if (agentUpdated !== 1) return false;
		const messageUpdated =
			mailbox && claimedPayload !== undefined
				? Number(
						compareAndWriteSerializedCanonicalMailboxPayload(
							db,
							mailbox.candidate.row,
							claimedPayload,
							input.updatedAt,
						),
					)
				: db
						.prepare(`DELETE FROM multi_agent_mailbox_messages
				 WHERE session_path = ? AND message_id = ? AND data = ?`)
						.run(input.sessionPath, input.messageId, plan.messageData).changes;
		if (messageUpdated !== 1) {
			throw new Error(`Steering message changed during delivery ${input.sessionPath}#${input.messageId}`);
		}
		return true;
	});
	return persisted ? { agent: plan.updatedAgent, message: plan.updatedMessage, ok: true } : undefined;
}

const MULTI_AGENT_LIFECYCLE_MUTATION_MAX_ATTEMPTS = 3;

type DetachedCancellationCommand = { message: string; messageId: string };

type MultiAgentLifecycleMutationPlan = {
	agentData: string;
	cancellation?: DetachedCancellationCommand;
	processIdentityData: string;
	updatedAgent: Record<string, unknown>;
	updatedAgentData: string;
};

type MultiAgentLifecycleMutationPreflight =
	| { plan: MultiAgentLifecycleMutationPlan }
	| { result: CommitMultiAgentLifecycleMutationResult };

type MultiAgentLifecycleAgentUpdate =
	| { result: CommitMultiAgentLifecycleMutationResult }
	| { cancellation?: DetachedCancellationCommand; updatedAgent: Record<string, unknown> };

export function commitMultiAgentLifecycleMutation(
	controlDbPath: string,
	input: CommitMultiAgentLifecycleMutationInput,
): CommitMultiAgentLifecycleMutationResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_LIFECYCLE_MUTATION_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareMultiAgentLifecycleMutation(db, input);
			if ("result" in preflight) return preflight.result;
			if (persistMultiAgentLifecycleMutation(db, input, preflight.plan)) {
				return { agent: preflight.plan.updatedAgent, ok: true };
			}
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

function prepareMultiAgentLifecycleMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentLifecycleMutationInput,
): MultiAgentLifecycleMutationPreflight {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.agentId) as { data: string } | undefined;
	if (!row) return { result: { ok: false, error: "agent_not_found" } };
	const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	if (!runtimeOwnerMatches(ownership, input)) return { result: { ok: false, error: "mutation_mismatch" } };
	const preparedUpdate = prepareMultiAgentLifecycleAgentUpdate(agent, input);
	if ("result" in preparedUpdate) return preparedUpdate;
	return {
		plan: {
			agentData: row.data,
			cancellation: preparedUpdate.cancellation,
			processIdentityData: serializeProcessIdentity(input.processIdentity),
			updatedAgent: preparedUpdate.updatedAgent,
			updatedAgentData: JSON.stringify(preparedUpdate.updatedAgent),
		},
	};
}

function prepareMultiAgentLifecycleAgentUpdate(
	agent: Record<string, unknown>,
	input: CommitMultiAgentLifecycleMutationInput,
): MultiAgentLifecycleAgentUpdate {
	const shouldPersistNotificationSuppression =
		input.detachedCancellation?.suppressTerminalNotification === true && agent.suppressTerminalNotification !== true;
	if (agent.lifecycle === input.requestedLifecycle && !shouldPersistNotificationSuppression) {
		return { result: { ok: true, agent } };
	}
	if (
		agent.lifecycle !== input.requestedLifecycle &&
		!canPersistLifecycleTransition(agent.lifecycle, input.requestedLifecycle)
	) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	const updatedAgent = {
		...agent,
		...(shouldPersistNotificationSuppression ? { suppressTerminalNotification: true } : {}),
		lifecycle: input.requestedLifecycle,
		revision: Number(agent.revision) + 1,
		updatedAt: input.updatedAt,
	};
	const cancellation =
		input.detachedCancellation && agent.lifecycle !== input.requestedLifecycle
			? buildDetachedCancellationMessage(input, input.detachedCancellation, updatedAgent.revision)
			: undefined;
	return { cancellation, updatedAgent };
}

function persistMultiAgentLifecycleMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentLifecycleMutationInput,
	plan: MultiAgentLifecycleMutationPlan,
): boolean {
	return withImmediateTransaction(db, () => {
		const updated = db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ?
				 AND EXISTS (
					SELECT 1 FROM multi_agent_runtime_owners
					WHERE session_path = ? AND agent_id = ? AND process_identity = ?
					AND owner_session_id = ? AND owner_agent_id IS ?
				 )`,
			)
			.run(
				plan.updatedAgentData,
				input.updatedAt,
				input.sessionPath,
				input.agentId,
				plan.agentData,
				input.sessionPath,
				input.agentId,
				plan.processIdentityData,
				input.owner.sessionId,
				input.owner.agentId,
			).changes;
		if (updated !== 1) return false;
		if (plan.cancellation) persistDetachedCancellationCommand(db, input, plan.cancellation);
		return true;
	});
}

function persistDetachedCancellationCommand(
	db: SqliteDatabase,
	input: CommitMultiAgentLifecycleMutationInput,
	command: DetachedCancellationCommand,
): void {
	assertMailboxMessageFresh(
		{ createdAt: input.updatedAt },
		`multi_agent_mailbox_messages:${input.sessionPath}#${command.messageId}`,
	);
	db.prepare(
		`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
		 VALUES (?, ?, ?, ?)`,
	).run(input.sessionPath, command.messageId, command.message, input.updatedAt);
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
			createdAt: input.updatedAt,
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

const MULTI_AGENT_TERMINAL_MUTATION_MAX_ATTEMPTS = 3;

type MultiAgentTerminalMutationPlan = {
	agentData: string;
	processIdentityData: string;
	terminalRevision: number;
	updatedAgentData: string;
};

type MultiAgentTerminalMutationPreflight =
	| { plan: MultiAgentTerminalMutationPlan }
	| { result: CommitMultiAgentTerminalMutationResult };

export function commitMultiAgentTerminalMutation(
	controlDbPath: string,
	input: CommitMultiAgentTerminalMutationInput,
): CommitMultiAgentTerminalMutationResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_TERMINAL_MUTATION_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareMultiAgentTerminalMutation(db, input);
			if ("result" in preflight) return preflight.result;
			const result = persistMultiAgentTerminalMutation(db, input, preflight.plan);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

function prepareMultiAgentTerminalMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentTerminalMutationInput,
): MultiAgentTerminalMutationPreflight {
	const agentRow = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.agentId) as { data: string } | undefined;
	if (!agentRow) return { result: { ok: false, error: "agent_not_found" } };
	const agent = parseStoredJsonObject(agentRow.data, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	if (!runtimeOwnerMatches(ownership, input)) {
		return { result: { ok: false, error: "mutation_mismatch" } };
	}
	if (agent.lifecycle === input.terminalLifecycle) {
		return { result: terminalMutationReplayResult(input, agent, Number(agent.revision)) };
	}
	const terminalRevision = Number(agent.revision) + 1;
	if (!canPersistTerminalTransition(agent.lifecycle, input.terminalLifecycle)) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	if (hasActivePersistedDescendant(db, input.sessionPath, input.agentId)) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	const updatedAgent = {
		...agent,
		...input.agentDetails,
		currentActivity: undefined,
		lifecycle: input.terminalLifecycle,
		revision: terminalRevision,
		updatedAt: input.updatedAt,
	};
	return {
		plan: {
			agentData: agentRow.data,
			processIdentityData: serializeProcessIdentity(input.processIdentity),
			terminalRevision,
			updatedAgentData: JSON.stringify(updatedAgent),
		},
	};
}

function persistMultiAgentTerminalMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentTerminalMutationInput,
	plan: MultiAgentTerminalMutationPlan,
): CommitMultiAgentTerminalMutationResult | undefined {
	return withImmediateTransaction(db, () => {
		const agentUpdated = updateTerminalAgentIfCurrent(db, {
			agentData: plan.agentData,
			agentId: input.agentId,
			owner: input.owner,
			processIdentityData: plan.processIdentityData,
			requireUniqueOwnership: false,
			sessionPath: input.sessionPath,
			updatedAgentData: plan.updatedAgentData,
			updatedAt: input.updatedAt,
		});
		if (!agentUpdated) return undefined;
		db.prepare(
			`INSERT INTO multi_agent_terminal_outbox (
				session_path, agent_id, terminal_revision, event_kind, status,
				claim_id, claimed_at, attempt_count, last_error, updated_at
			) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, 0, NULL, ?)`,
		).run(input.sessionPath, input.agentId, plan.terminalRevision, input.eventKind, input.updatedAt);
		return { ok: true, terminalRevision: plan.terminalRevision };
	});
}

type TerminalAgentCasInput = {
	agentData: string;
	agentId: string;
	owner: { agentId: string | null; sessionId: string };
	processIdentityData: string;
	requireUniqueOwnership: boolean;
	sessionPath: string;
	updatedAgentData: string;
	updatedAt: string;
};

function updateTerminalAgentIfCurrent(db: SqliteDatabase, input: TerminalAgentCasInput): boolean {
	return (
		db
			.prepare(
				`WITH RECURSIVE descendants(agent_id) AS (
					SELECT agent_id FROM multi_agent_agents
					WHERE session_path = ? AND json_valid(data)
					AND json_extract(data, '$.parentId') = ?
					UNION
					SELECT child.agent_id FROM multi_agent_agents AS child
					JOIN descendants AS parent
						ON json_valid(child.data) AND json_extract(child.data, '$.parentId') = parent.agent_id
					WHERE child.session_path = ?
				)
				UPDATE multi_agent_agents SET data = ?, updated_at = ?
				WHERE session_path = ? AND agent_id = ? AND data = ?
				AND EXISTS (
					SELECT 1 FROM multi_agent_runtime_owners
					WHERE session_path = ? AND agent_id = ? AND process_identity = ?
					AND owner_session_id = ? AND owner_agent_id IS ?
				)
				AND (? = 0 OR (
					SELECT COUNT(*) FROM multi_agent_runtime_owners AS matching_owner
					WHERE matching_owner.agent_id = ? AND matching_owner.process_identity = ?
					AND matching_owner.owner_session_id = ? AND matching_owner.owner_agent_id IS ?
				) = 1)
				AND NOT EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND NOT json_valid(data)
				)
				AND NOT EXISTS (
					SELECT 1 FROM multi_agent_agents AS active
					JOIN descendants ON descendants.agent_id = active.agent_id
					WHERE active.session_path = ?
					AND json_extract(active.data, '$.lifecycle') NOT IN ('completed', 'failed', 'aborted')
				)`,
			)
			.run(
				input.sessionPath,
				input.agentId,
				input.sessionPath,
				input.updatedAgentData,
				input.updatedAt,
				input.sessionPath,
				input.agentId,
				input.agentData,
				input.sessionPath,
				input.agentId,
				input.processIdentityData,
				input.owner.sessionId,
				input.owner.agentId,
				input.requireUniqueOwnership ? 1 : 0,
				input.agentId,
				input.processIdentityData,
				input.owner.sessionId,
				input.owner.agentId,
				input.sessionPath,
				input.sessionPath,
			).changes === 1
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

function terminalMutationReplayResult(
	input: CommitMultiAgentTerminalMutationInput,
	agent: Record<string, unknown>,
	terminalRevision: number,
): CommitMultiAgentTerminalMutationResult {
	for (const [key, value] of Object.entries(input.agentDetails ?? {})) {
		if (JSON.stringify(agent[key]) !== JSON.stringify(value)) return { ok: false, error: "mutation_mismatch" };
	}
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

const FINALIZE_DETACHED_JOB_MAX_ATTEMPTS = 3;

type PreparedTerminalTransport = {
	input: EnqueueStoredRuntimeMailboxMessageInput;
	prepared: PreparedStoredRuntimeMailboxMessage;
};

type FinalizeDetachedJobPlan = {
	agentData: string;
	eventKind: string;
	ownership: MultiAgentRuntimeOwnershipRow;
	processIdentityData: string;
	sessionPath: string;
	terminalAgent: AgentSnapshot;
	terminalAgentData: string;
	terminalRevision: number;
	terminalTransport?: PreparedTerminalTransport;
};

type FinalizeDetachedJobPreflight = { plan: FinalizeDetachedJobPlan } | { result: FinalizeDetachedJobResult };

export function finalizeDetachedJob(controlDbPath: string, input: FinalizeDetachedJobInput): FinalizeDetachedJobResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= FINALIZE_DETACHED_JOB_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareDetachedJobFinalization(db, input);
			if ("result" in preflight) return preflight.result;
			const result = persistDetachedJobFinalization(db, input.terminal, preflight.plan);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
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

function prepareDetachedJobFinalization(
	db: SqliteDatabase,
	input: FinalizeDetachedJobInput,
): FinalizeDetachedJobPreflight {
	const sessionPath = findDetachedJobSessionPath(db, input);
	if (!sessionPath) return { result: detachedJobLookupFailure(db, input) };
	const terminal = input.terminal;
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, terminal.jobId) as { data: string } | undefined;
	if (!row) return { result: { ok: false, error: "agent_not_found" } };
	const context = `multi_agent_agents:${sessionPath}#${terminal.jobId}`;
	const agent = parseStoredJsonObject(row.data, context);
	const terminalLifecycle = resolveDetachedJobTerminalLifecycle(agent.lifecycle, terminal);
	const eventKind = `detached_job_${terminalLifecycle}`;
	const ownership = readMultiAgentRuntimeOwnershipRow(db, sessionPath, terminal.jobId);
	if (!ownership || !detachedJobOwnershipMatches(ownership, sessionPath, terminal)) {
		return { result: { ok: false, error: "mutation_mismatch" } };
	}
	if (agent.lifecycle === terminalLifecycle) {
		return {
			result: detachedJobReplayResult(sessionPath, terminal, agent, Number(agent.revision)),
		};
	}
	const terminalRevision = Number(agent.revision) + 1;
	const canFinalize = agent.lifecycle === "running" || agent.lifecycle === "cancelling";
	if (!canFinalize || hasActivePersistedDescendant(db, sessionPath, terminal.jobId)) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	const terminalAgent = {
		...agent,
		...detachedJobAgentDetails(agent, terminal, terminalLifecycle),
		currentActivity: undefined,
		lifecycle: terminalLifecycle,
		revision: terminalRevision,
		updatedAt: terminal.terminalAt,
		worker: undefined,
	};
	validatePersistedAgentPayload(terminalAgent, context);
	const terminalTransport = shouldNotifyDetachedJobOwner(agent)
		? prepareDetachedAgentTerminalTransport(
				sessionPath,
				terminal.jobId,
				{
					agentId: ownership.owner_agent_id,
					sessionId: ownership.owner_session_id ?? undefined,
				},
				terminalRevision,
				eventKind,
				terminal.terminalAt,
			)
		: undefined;
	return {
		plan: {
			agentData: row.data,
			eventKind,
			ownership,
			processIdentityData: serializeProcessIdentity(terminal.processIdentity),
			sessionPath,
			terminalAgent: terminalAgent as unknown as AgentSnapshot,
			terminalAgentData: JSON.stringify(terminalAgent),
			terminalRevision,
			terminalTransport,
		},
	};
}

function resolveDetachedJobTerminalLifecycle(
	persistedLifecycle: unknown,
	terminal: DetachedJobTerminalInput,
): "aborted" | "completed" | "failed" {
	if (persistedLifecycle === "completed" || persistedLifecycle === "failed" || persistedLifecycle === "aborted") {
		return persistedLifecycle;
	}
	return persistedLifecycle === "cancelling" ? "aborted" : terminal.outcome.kind;
}

function detachedJobOwnershipMatches(
	ownership: MultiAgentRuntimeOwnershipRow,
	sessionPath: string,
	terminal: DetachedJobTerminalInput,
): boolean {
	return runtimeOwnerMatches(ownership, {
		agentId: terminal.jobId,
		owner: terminal.owner,
		processIdentity: terminal.processIdentity,
		sessionPath,
	});
}

function detachedJobReplayResult(
	sessionPath: string,
	terminal: DetachedJobTerminalInput,
	terminalAgent: Record<string, unknown>,
	terminalRevision: number,
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
	validatePersistedAgentPayload(terminalAgent, `multi_agent_agents:${sessionPath}#${terminal.jobId}`);
	return { ok: true, terminalAgent: terminalAgent as unknown as AgentSnapshot, terminalRevision };
}

function persistDetachedJobFinalization(
	db: SqliteDatabase,
	terminal: DetachedJobTerminalInput,
	plan: FinalizeDetachedJobPlan,
): FinalizeDetachedJobResult | undefined {
	return withImmediateTransaction(db, () => {
		const agentUpdated = updateTerminalAgentIfCurrent(db, {
			agentData: plan.agentData,
			agentId: terminal.jobId,
			owner: terminal.owner,
			processIdentityData: plan.processIdentityData,
			requireUniqueOwnership: true,
			sessionPath: plan.sessionPath,
			updatedAgentData: plan.terminalAgentData,
			updatedAt: terminal.terminalAt,
		});
		if (!agentUpdated) return undefined;
		db.prepare(
			`INSERT INTO multi_agent_terminal_outbox
				(session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at)
			 VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
		).run(plan.sessionPath, terminal.jobId, plan.terminalRevision, plan.eventKind, terminal.terminalAt);
		// Attended jobs deliver their result in-band through the waiting tool call;
		// only jobs explicitly detached from their tool call notify the supervisor.
		if (plan.terminalTransport) persistPreparedTerminalTransport(db, plan.terminalTransport);
		return { ok: true, terminalAgent: plan.terminalAgent, terminalRevision: plan.terminalRevision };
	});
}

function shouldNotifyDetachedJobOwner(agent: Record<string, unknown>): boolean {
	return agent.detached === true && agent.suppressTerminalNotification !== true;
}

function prepareDetachedAgentTerminalTransport(
	sessionPath: string,
	agentId: string,
	owner: { agentId: string | null; sessionId?: string },
	terminalRevision: number,
	eventKind: string,
	terminalAt: string,
): PreparedTerminalTransport {
	const ownerSessionId = owner.sessionId;
	if (!ownerSessionId) throw new Error(`Detached job ${agentId} ownership has no owner session`);
	const messageId = `terminal:${agentId}:${terminalRevision}:${eventKind}`;
	const body = JSON.stringify({ agentId, eventKind, terminalRevision, type: "multi_agent_terminal" });
	const input: EnqueueStoredRuntimeMailboxMessageInput = {
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
	};
	return { input, prepared: prepareStoredRuntimeMailboxMessage(input) };
}

function persistPreparedTerminalTransport(db: SqliteDatabase, transport: PreparedTerminalTransport): void {
	assertMailboxMessageFresh(transport.prepared.routed, transport.prepared.context);
	db.prepare(
		`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
		 VALUES (?, ?, ?, ?)`,
	).run(
		transport.input.storeRef.sessionPath,
		transport.input.storeRef.messageId,
		transport.prepared.serialized,
		transport.prepared.updatedAt,
	);
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

const DEAD_RUNTIME_RECOVERY_MAX_ATTEMPTS = 3;

type SupervisorRecoveryAuthority = {
	listener: RuntimeMailboxListenerRow;
	supervisor: SupervisorRuntimeOwnership;
	supervisorAgentData?: string;
};

type DeadRuntimeRecoveryPlan = {
	agentData: string;
	processIdentityData: string;
	terminalRevision: number;
	terminalTransport?: PreparedTerminalTransport;
	updatedAgent: Record<string, unknown> & { updatedAt: string };
	updatedAgentData: string;
};

export function recoverDeadMultiAgentRuntime(
	controlDbPath: string,
	input: RecoverDeadMultiAgentRuntimeInput,
): RecoverDeadMultiAgentRuntimeResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= DEAD_RUNTIME_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
			const supervisorAuthority = readSupervisorRecoveryAuthority(
				db,
				input.expectedOwner.sessionPath,
				input.supervisor,
			);
			if (!supervisorAuthority) return { ok: false, error: "mutation_mismatch" };
			const replay = readDeadRuntimeRecoveryReplay(db, input.expectedOwner);
			if (replay) return replay;
			const recoverable = readRecoverableMultiAgentRuntime(
				db,
				input.expectedOwner,
				input.supervisor.processIdentity,
			);
			if (!recoverable.ok) return recoverable;
			const plan = prepareDeadRuntimeRecovery(recoverable, input.expectedOwner, input.nowIso);
			const result = persistDeadRuntimeRecovery(db, input.expectedOwner, plan, supervisorAuthority);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

function readDeadRuntimeRecoveryReplay(
	db: SqliteDatabase,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
): RecoverDeadMultiAgentRuntimeResult | undefined {
	const { agentId, sessionPath } = expectedOwner;
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, agentId) as { data: string } | undefined;
	if (!row) return undefined;
	const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${sessionPath}#${agentId}`);
	if (agent.lifecycle !== "failed" && agent.lifecycle !== "aborted") return undefined;
	const error = agent.error as { code?: unknown } | undefined;
	if (error?.code !== "lost_runtime") return undefined;
	const owner = readMultiAgentRuntimeOwnershipRow(db, sessionPath, agentId);
	if (!owner || owner.process_identity !== null || owner.owner_session_id !== null || owner.owner_agent_id !== null) {
		return undefined;
	}
	validatePersistedAgentPayload(agent, `multi_agent_agents:${sessionPath}#${agentId}`);
	return { agent, ok: true, terminalRevision: Number(agent.revision) };
}

function readSupervisorRecoveryAuthority(
	db: SqliteDatabase,
	sessionPath: string,
	supervisor: SupervisorRuntimeOwnership,
): SupervisorRecoveryAuthority | undefined {
	if (!isProcessIdentityAlive(supervisor.processIdentity)) return undefined;
	const listener = readRuntimeMailboxListenerRow(db, {
		agentId: supervisor.agentId ?? null,
		sessionId: supervisor.sessionId,
	});
	if (!listener?.runtime_instance_id || listener.pid !== supervisor.processIdentity.pid) return undefined;
	try {
		const listenerIdentity = serializeProcessIdentity(parseProcessIdentity(listener.runtime_instance_id));
		if (listenerIdentity !== serializeProcessIdentity(supervisor.processIdentity)) return undefined;
	} catch {
		return undefined;
	}
	if (!supervisor.agentId) {
		if (listener.session_path !== sessionPath || listener.session_path_asserted_at === null) return undefined;
		return { listener, supervisor };
	}
	const supervisorRow = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, supervisor.agentId) as { data: string } | undefined;
	if (!supervisorRow) return undefined;
	const snapshot = parseStoredJsonObject(
		supervisorRow.data,
		`multi_agent_agents:${sessionPath}#${supervisor.agentId}`,
	) as unknown as AgentSnapshot;
	if (snapshot.transcript?.sessionId !== supervisor.sessionId || !isActiveLifecycle(snapshot.lifecycle)) {
		return undefined;
	}
	return { listener, supervisor, supervisorAgentData: supervisorRow.data };
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
	return withControlDb(controlDbPath, (db) => {
		const expectedOwners = readDeadDetachedRuntimeCandidates(db).flatMap((candidate) => {
			const owner = readDetachedOwnerForRecovery(db, candidate);
			return owner ? [owner] : [];
		});
		return expectedOwners.reduce(
			(count, expectedOwner) => count + reconcileDeadDetachedAgentRuntime(db, expectedOwner, nowIso),
			0,
		);
	});
}

function reconcileDeadDetachedAgentRuntime(
	db: SqliteDatabase,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
	nowIso: string,
): number {
	for (let attempt = 1; attempt <= DEAD_RUNTIME_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
		const recoverable = readRecoverableMultiAgentRuntime(db, expectedOwner);
		if (!recoverable.ok) return 0;
		const plan = prepareDeadRuntimeRecovery(recoverable, expectedOwner, nowIso);
		const result = persistDeadRuntimeRecovery(db, expectedOwner, plan);
		if (result) return result.ok ? 1 : 0;
	}
	return 0;
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
	if (isProcessIdentityAlive(processIdentity)) return undefined;
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

type RecoverDeadMultiAgentRuntimeFailure = Extract<RecoverDeadMultiAgentRuntimeResult, { ok: false }>;

type RecoverableMultiAgentRuntime =
	| { agent: Record<string, unknown>; agentData: string; ok: true }
	| RecoverDeadMultiAgentRuntimeFailure;

function readRecoverableMultiAgentRuntime(
	db: SqliteDatabase,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
	replacementProcessIdentity?: ProcessIdentity,
): RecoverableMultiAgentRuntime {
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
	const ownerAlive = isProcessIdentityAlive(expectedOwner.processIdentity);
	const ownerSuperseded =
		replacementProcessIdentity !== undefined &&
		isSupersededRuntimeIdentity(expectedOwner.processIdentity, replacementProcessIdentity);
	if (replacementProcessIdentity !== undefined && ownerAlive && !ownerSuperseded) {
		return { ok: false, error: "owner_alive" };
	}
	return { agent, agentData: row.data, ok: true };
}

function prepareDeadRuntimeRecovery(
	recoverable: Extract<RecoverableMultiAgentRuntime, { ok: true }>,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
	nowIso: string,
): DeadRuntimeRecoveryPlan {
	const { agent } = recoverable;
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
	const updatedAgent = {
		...agent,
		error,
		lifecycle: cancelling ? "aborted" : "failed",
		...(toolCallId === undefined ? {} : { result: { ...result, toolCallId } }),
		revision: terminalRevision,
		updatedAt: nowIso,
		worker: undefined,
	};
	const terminalTransport = shouldNotifyDetachedJobOwner(agent)
		? prepareDetachedAgentTerminalTransport(
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				expectedOwner.owner,
				terminalRevision,
				"lost_runtime",
				nowIso,
			)
		: undefined;
	return {
		agentData: recoverable.agentData,
		processIdentityData: serializeProcessIdentity(expectedOwner.processIdentity),
		terminalRevision,
		terminalTransport,
		updatedAgent,
		updatedAgentData: JSON.stringify(updatedAgent),
	};
}

function persistDeadRuntimeRecovery(
	db: SqliteDatabase,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
	plan: DeadRuntimeRecoveryPlan,
	supervisorAuthority?: SupervisorRecoveryAuthority,
): RecoverDeadMultiAgentRuntimeResult | undefined {
	return withImmediateTransaction(db, () => {
		if (!releaseDeadRuntimeOwnershipIfCurrent(db, expectedOwner, plan, supervisorAuthority)) return undefined;
		const agentUpdated = db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ?`,
			)
			.run(
				plan.updatedAgentData,
				plan.updatedAgent.updatedAt,
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				plan.agentData,
			).changes;
		if (agentUpdated !== 1) {
			throw new Error(
				`Recovered agent changed after ownership release ${expectedOwner.sessionPath}#${expectedOwner.agentId}`,
			);
		}
		db.prepare(
			`INSERT INTO multi_agent_terminal_outbox
				(session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at)
			 VALUES (?, ?, ?, 'lost_runtime', 'pending', 0, ?)`,
		).run(expectedOwner.sessionPath, expectedOwner.agentId, plan.terminalRevision, plan.updatedAgent.updatedAt);
		if (plan.terminalTransport) persistPreparedTerminalTransport(db, plan.terminalTransport);
		return { agent: plan.updatedAgent, ok: true, terminalRevision: plan.terminalRevision };
	});
}

function releaseDeadRuntimeOwnershipIfCurrent(
	db: SqliteDatabase,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
	plan: DeadRuntimeRecoveryPlan,
	supervisorAuthority?: SupervisorRecoveryAuthority,
): boolean {
	const listener = supervisorAuthority?.listener;
	const supervisor = supervisorAuthority?.supervisor;
	const supervisorAgentData = supervisorAuthority?.supervisorAgentData;
	return (
		db
			.prepare(
				`WITH RECURSIVE descendants(agent_id) AS (
					SELECT agent_id FROM multi_agent_agents
					WHERE session_path = ? AND json_valid(data)
					AND json_extract(data, '$.parentId') = ?
					UNION
					SELECT child.agent_id FROM multi_agent_agents AS child
					JOIN descendants AS parent
						ON json_valid(child.data) AND json_extract(child.data, '$.parentId') = parent.agent_id
					WHERE child.session_path = ?
				)
				UPDATE multi_agent_runtime_owners
				SET process_identity = NULL, owner_session_id = NULL, owner_agent_id = NULL
				WHERE session_path = ? AND agent_id = ? AND process_identity = ?
				AND owner_session_id = ? AND owner_agent_id IS ?
				AND EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND agent_id = ? AND data = ?
				)
				AND NOT EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND NOT json_valid(data)
				)
				AND NOT EXISTS (
					SELECT 1 FROM multi_agent_agents AS active
					JOIN descendants ON descendants.agent_id = active.agent_id
					WHERE active.session_path = ?
					AND json_extract(active.data, '$.lifecycle') NOT IN ('completed', 'failed', 'aborted')
				)
				AND NOT EXISTS (
					SELECT 1 FROM multi_agent_terminal_outbox
					WHERE session_path = ? AND agent_id = ?
				)
				AND (? = 0 OR EXISTS (
					SELECT 1 FROM runtime_mailbox_listeners
					WHERE recipient_session_id = ? AND recipient_agent_id_key = ? AND pid = ?
					AND runtime_instance_id IS ? AND session_path IS ?
					AND session_path_asserted_at IS ? AND updated_at = ?
				))
				AND (? = 0 OR EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND agent_id = ? AND data = ?
				))`,
			)
			.run(
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				expectedOwner.sessionPath,
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				plan.processIdentityData,
				expectedOwner.owner.sessionId,
				expectedOwner.owner.agentId,
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				plan.agentData,
				expectedOwner.sessionPath,
				expectedOwner.sessionPath,
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				supervisorAuthority ? 1 : 0,
				supervisor?.sessionId ?? null,
				supervisor?.agentId ?? "",
				listener?.pid ?? null,
				listener?.runtime_instance_id ?? null,
				listener?.session_path ?? null,
				listener?.session_path_asserted_at ?? null,
				listener?.updated_at ?? null,
				supervisorAgentData ? 1 : 0,
				expectedOwner.sessionPath,
				supervisor?.agentId ?? null,
				supervisorAgentData ?? null,
			).changes === 1
	);
}

const MULTI_AGENT_CREATION_MAX_ATTEMPTS = 3;

type ActiveParentSnapshot = {
	agent?: AgentSnapshot;
	data?: string;
	parentId: string;
};

export function createFailedMultiAgentChild(
	controlDbPath: string,
	input: CreateFailedMultiAgentChildInput,
): CreateFailedMultiAgentChildResult {
	const agent = input.agent as AgentSnapshot & Record<string, unknown>;
	validatePersistedAgentPayload(agent, `multi_agent_agents:${input.sessionPath}#${agent.id}`);
	if (agent.lifecycle !== "failed" || agent.revision !== 1) {
		throw new Error("Failed child creation requires failed revision 1");
	}
	const parentId = agent.parentId;
	if (!parentId) return { ok: false, error: "parent_not_found" };
	const serializedAgent = JSON.stringify(agent);
	return withControlDb(controlDbPath, (db) =>
		createFailedMultiAgentChildWithDb(db, input, agent, parentId, serializedAgent),
	);
}

function createFailedMultiAgentChildWithDb(
	db: SqliteDatabase,
	input: CreateFailedMultiAgentChildInput,
	agent: AgentSnapshot & Record<string, unknown>,
	parentId: string,
	serializedAgent: string,
): CreateFailedMultiAgentChildResult {
	for (let attempt = 1; attempt <= MULTI_AGENT_CREATION_MAX_ATTEMPTS; attempt += 1) {
		const parent = readActiveParentSnapshot(db, input.sessionPath, parentId);
		if (!parent) return { ok: false, error: "parent_not_found" };
		if (multiAgentAgentExists(db, input.sessionPath, agent.id)) return { ok: false, error: "agent_exists" };
		const result = commitFailedMultiAgentChild(db, input, agent, serializedAgent, parent);
		if (result) return result;
	}
	throw new Error(`Failed child parent changed repeatedly ${input.sessionPath}#${agent.id}`);
}

function commitFailedMultiAgentChild(
	db: SqliteDatabase,
	input: CreateFailedMultiAgentChildInput,
	agent: AgentSnapshot & Record<string, unknown>,
	serializedAgent: string,
	parent: ActiveParentSnapshot,
): CreateFailedMultiAgentChildResult | undefined {
	return withImmediateTransaction(db, () => {
		if (
			!insertMultiAgentAgentIfParentCurrent(db, input.sessionPath, agent.id, serializedAgent, input.nowIso, parent)
		) {
			return undefined;
		}
		db.prepare(
			`INSERT INTO multi_agent_terminal_outbox (
				session_path, agent_id, terminal_revision, event_kind, status,
				claim_id, claimed_at, attempt_count, last_error, updated_at
			) VALUES (?, ?, 1, 'failed', 'pending', NULL, NULL, 0, NULL, ?)`,
		).run(input.sessionPath, agent.id, input.nowIso);
		return { ok: true, agent };
	});
}

function readActiveParentSnapshot(
	db: SqliteDatabase,
	sessionPath: string,
	parentId: string,
): ActiveParentSnapshot | undefined {
	if (parentId === "main") return { parentId };
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, parentId) as { data: string } | undefined;
	if (!row) return undefined;
	const context = `multi_agent_agents:${sessionPath}#${parentId}`;
	const parent = parseStoredJsonObject(row.data, context);
	validatePersistedAgentPayload(parent, context);
	if (!isNonterminalLifecycle(parent.lifecycle)) return undefined;
	return { agent: parent as unknown as AgentSnapshot, data: row.data, parentId };
}

function multiAgentAgentExists(db: SqliteDatabase, sessionPath: string, agentId: string): boolean {
	return Boolean(
		db.prepare("SELECT 1 FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?").get(sessionPath, agentId),
	);
}

function insertMultiAgentAgentIfParentCurrent(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
	serializedAgent: string,
	updatedAt: string,
	parent: ActiveParentSnapshot,
): boolean {
	return (
		db
			.prepare(
				`INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at)
				 SELECT ?, ?, ?, ?
				 WHERE (? = 'main' OR EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND agent_id = ? AND data = ?
				 ))
				 ON CONFLICT(session_path, agent_id) DO NOTHING`,
			)
			.run(
				sessionPath,
				agentId,
				serializedAgent,
				updatedAt,
				parent.parentId,
				sessionPath,
				parent.parentId,
				parent.data ?? null,
			).changes === 1
	);
}

export function createMultiAgentChildWithRuntimeOwnership(
	controlDbPath: string,
	input: CreateMultiAgentChildWithRuntimeOwnershipInput,
): CreateMultiAgentChildWithRuntimeOwnershipResult {
	const agent = input.agent as Record<string, unknown>;
	validatePersistedAgentPayload(agent, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
	if (agent.id !== input.agentId) throw new Error("Child agent payload ID does not match runtime ownership identity");
	if (agent.lifecycle !== "running" || agent.revision !== 1) {
		throw new Error("Child runtime ownership requires running revision 1");
	}
	const parentId = typeof agent.parentId === "string" ? agent.parentId : undefined;
	if (!parentId) return { ok: false, error: "parent_not_found" };
	const processIdentityData = serializeProcessIdentity(input.processIdentity);
	const serializedAgent = JSON.stringify(input.agent);
	return withControlDb(controlDbPath, (db) =>
		createMultiAgentChildWithRuntimeOwnershipWithDb(db, input, parentId, processIdentityData, serializedAgent),
	);
}

function createMultiAgentChildWithRuntimeOwnershipWithDb(
	db: SqliteDatabase,
	input: CreateMultiAgentChildWithRuntimeOwnershipInput,
	parentId: string,
	processIdentityData: string,
	serializedAgent: string,
): CreateMultiAgentChildWithRuntimeOwnershipResult {
	for (let attempt = 1; attempt <= MULTI_AGENT_CREATION_MAX_ATTEMPTS; attempt += 1) {
		const parent = readActiveParentSnapshot(db, input.sessionPath, parentId);
		if (!parent) return { ok: false, error: "parent_not_found" };
		if (multiAgentAgentExists(db, input.sessionPath, input.agentId)) return { ok: false, error: "agent_exists" };
		const result = commitMultiAgentChildWithRuntimeOwnership(db, input, processIdentityData, serializedAgent, parent);
		if (result) return result;
	}
	throw new Error(`Child parent changed repeatedly ${input.sessionPath}#${input.agentId}`);
}

function commitMultiAgentChildWithRuntimeOwnership(
	db: SqliteDatabase,
	input: CreateMultiAgentChildWithRuntimeOwnershipInput,
	processIdentityData: string,
	serializedAgent: string,
	parent: ActiveParentSnapshot,
): CreateMultiAgentChildWithRuntimeOwnershipResult | undefined {
	return withImmediateTransaction(db, () => {
		if (
			!insertMultiAgentAgentIfParentCurrent(
				db,
				input.sessionPath,
				input.agentId,
				serializedAgent,
				input.nowIso,
				parent,
			)
		) {
			return undefined;
		}
		persistAcquiredRuntimeOwnership(db, input, processIdentityData);
		return { agent: input.agent, ok: true, ownership: multiAgentRuntimeOwnershipFromInput(input) };
	});
}

export function createMultiAgentAttachment(
	controlDbPath: string,
	input: CreateMultiAgentAttachmentInput,
): CreateMultiAgentAttachmentResult {
	const agent = input.agent as AgentSnapshot & Record<string, unknown>;
	validatePersistedAgentPayload(agent, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
	if (agent.id !== input.agentId) throw new Error("Attached agent payload ID does not match command identity");
	if (agent.origin !== "attached" || agent.lifecycle !== "waiting_for_input" || agent.revision !== 1) {
		throw new Error("Attached agent creation requires waiting_for_input revision 1");
	}
	const serializedAgent = JSON.stringify(agent);
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_CREATION_MAX_ATTEMPTS; attempt += 1) {
			if (multiAgentAgentExists(db, input.sessionPath, input.agentId)) return { ok: false, error: "agent_exists" };
			const parent = readAttachmentParentSnapshot(db, input.sessionPath, agent);
			if ("error" in parent) return { ok: false, error: parent.error };
			if (
				insertMultiAgentAgentIfParentCurrent(
					db,
					input.sessionPath,
					input.agentId,
					serializedAgent,
					input.nowIso,
					parent,
				)
			) {
				return { ok: true, agent: input.agent };
			}
		}
		throw new Error(`Attachment parent changed repeatedly ${input.sessionPath}#${input.agentId}`);
	});
}

function readAttachmentParentSnapshot(
	db: SqliteDatabase,
	sessionPath: string,
	agent: AgentSnapshot & Record<string, unknown>,
): ActiveParentSnapshot | { error: "parent_not_found" | "permission_broadened" } {
	const parentId = agent.parentId;
	if (!parentId || parentId === "main") return { parentId: "main" };
	const parent = readActiveParentSnapshot(db, sessionPath, parentId);
	if (!parent?.agent) return { error: "parent_not_found" };
	const parentPermission = parent.agent.permission;
	const permissionMatches = agent.permission.narrowed && agent.permission.policy === parentPermission.policy;
	return permissionMatches ? parent : { error: "permission_broadened" };
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

const ATTACHED_RUNTIME_OWNERSHIP_MAX_ATTEMPTS = 3;

type SupervisorSessionAuthoritySnapshot = {
	listener: {
		runtime_instance_id: string;
		session_path: string | null;
		session_path_asserted_at: string | null;
	};
	supervisorAgentData?: string;
};

type AcquireAttachedRuntimeOwnershipPlan = {
	agentData: string;
	ownership: MultiAgentRuntimeOwnershipRow | undefined;
	processIdentityData: string;
	supervisorAuthority: SupervisorSessionAuthoritySnapshot;
	updatedAgent: Record<string, unknown>;
	updatedAgentData: string;
};

type AcquireAttachedRuntimeOwnershipPreflight =
	| { plan: AcquireAttachedRuntimeOwnershipPlan }
	| { result: AcquireAttachedRuntimeOwnershipResult };

type AttachedRuntimeAgentRead =
	| { agent: Record<string, unknown>; data: string; ok: true }
	| { error: "agent_not_found" | "invalid_agent"; ok: false };

export function acquireAttachedRuntimeOwnership(
	controlDbPath: string,
	input: AcquireAttachedRuntimeOwnershipInput,
): AcquireAttachedRuntimeOwnershipResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= ATTACHED_RUNTIME_OWNERSHIP_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareAttachedRuntimeOwnershipAcquisition(db, input);
			if ("result" in preflight) return preflight.result;
			const result = commitAttachedRuntimeOwnershipAcquisition(db, input, preflight.plan);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

function prepareAttachedRuntimeOwnershipAcquisition(
	db: SqliteDatabase,
	input: AcquireAttachedRuntimeOwnershipInput,
): AcquireAttachedRuntimeOwnershipPreflight {
	const supervisorAuthority = readRegisteredSupervisorSessionAuthority(db, input.sessionPath, input.supervisor);
	if (!supervisorAuthority) return { result: { ok: false, error: "mutation_mismatch" } };
	const agentRead = readAttachedRuntimeAgent(db, input.sessionPath, input.agentId);
	if (!agentRead.ok) return { result: agentRead };
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	const currentIdentity = ownership?.process_identity ? parseProcessIdentity(ownership.process_identity) : undefined;
	const currentOwnerAlive = currentIdentity !== undefined && isProcessIdentityAlive(currentIdentity);
	if (ownership && currentOwnerAlive && runtimeOwnerMatches(ownership, input)) {
		return {
			result: {
				agent: agentRead.agent as unknown as AgentSnapshot,
				ok: true,
				ownership: multiAgentRuntimeOwnershipFromRow(ownership),
			},
		};
	}
	const replacesCurrentIncarnation =
		currentIdentity !== undefined && isSupersededRuntimeIdentity(currentIdentity, input.processIdentity);
	if (currentOwnerAlive && !replacesCurrentIncarnation) {
		return { result: { ok: false, error: "ownership_held" } };
	}
	const updatedAgent = {
		...agentRead.agent,
		revision: Number(agentRead.agent.revision) + 1,
		updatedAt: input.nowIso,
	};
	return {
		plan: {
			agentData: agentRead.data,
			ownership,
			processIdentityData: serializeProcessIdentity(input.processIdentity),
			supervisorAuthority,
			updatedAgent,
			updatedAgentData: JSON.stringify(updatedAgent),
		},
	};
}

function readAttachedRuntimeAgent(db: SqliteDatabase, sessionPath: string, agentId: string): AttachedRuntimeAgentRead {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, agentId) as { data: string } | undefined;
	if (!row) return { ok: false, error: "agent_not_found" };
	const context = `multi_agent_agents:${sessionPath}#${agentId}`;
	const agent = parseStoredJsonObject(row.data, context);
	validatePersistedAgentPayload(agent, context);
	if (!isRecoverableRuntimeLifecycle(agent.lifecycle)) return { ok: false, error: "invalid_agent" };
	return { agent, data: row.data, ok: true };
}

function commitAttachedRuntimeOwnershipAcquisition(
	db: SqliteDatabase,
	input: AcquireAttachedRuntimeOwnershipInput,
	plan: AcquireAttachedRuntimeOwnershipPlan,
): AcquireAttachedRuntimeOwnershipResult | undefined {
	const persisted = withImmediateTransaction(db, () => {
		if (!supervisorSessionAuthorityIsCurrent(db, input.sessionPath, input.supervisor, plan.supervisorAuthority)) {
			return { ok: false, error: "mutation_mismatch" } as const;
		}
		const row = db
			.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
			.get(input.sessionPath, input.agentId) as { data: string } | undefined;
		if (!row) return { ok: false, error: "agent_not_found" } as const;
		if (row.data !== plan.agentData) return undefined;
		const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
		if (!multiAgentRuntimeOwnershipRowsEqual(plan.ownership, ownership)) return undefined;
		persistAttachedRuntimeOwnershipAcquisition(db, input, plan);
		return true;
	});
	if (persisted !== true) return persisted;
	return {
		agent: plan.updatedAgent as unknown as AgentSnapshot,
		ok: true,
		ownership: multiAgentRuntimeOwnershipFromInput(input),
	};
}

function persistAttachedRuntimeOwnershipAcquisition(
	db: SqliteDatabase,
	input: AcquireAttachedRuntimeOwnershipInput,
	plan: AcquireAttachedRuntimeOwnershipPlan,
): void {
	persistAcquiredRuntimeOwnership(db, input, plan.processIdentityData);
	db.prepare("UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?").run(
		plan.updatedAgentData,
		input.nowIso,
		input.sessionPath,
		input.agentId,
	);
}

function readRegisteredSupervisorSessionAuthority(
	db: SqliteDatabase,
	sessionPath: string,
	supervisor: SupervisorRuntimeOwnership,
): SupervisorSessionAuthoritySnapshot | undefined {
	if (!isProcessIdentityAlive(supervisor.processIdentity)) return undefined;
	const authority = readPersistedSupervisorSessionAuthority(db, sessionPath, supervisor);
	if (!authority) return undefined;
	try {
		const listenerIdentity = serializeProcessIdentity(parseProcessIdentity(authority.listener.runtime_instance_id));
		return listenerIdentity === serializeProcessIdentity(supervisor.processIdentity) ? authority : undefined;
	} catch {
		return undefined;
	}
}

function readPersistedSupervisorSessionAuthority(
	db: SqliteDatabase,
	sessionPath: string,
	supervisor: SupervisorRuntimeOwnership,
): SupervisorSessionAuthoritySnapshot | undefined {
	const listener = db
		.prepare(
			`SELECT runtime_instance_id, session_path, session_path_asserted_at
			 FROM runtime_mailbox_listeners
			 WHERE recipient_session_id = ? AND recipient_agent_id_key = ? AND pid = ?`,
		)
		.get(supervisor.sessionId, supervisor.agentId ?? "", supervisor.processIdentity.pid) as
		| {
				runtime_instance_id: string | null;
				session_path: string | null;
				session_path_asserted_at: string | null;
		  }
		| undefined;
	if (!listener?.runtime_instance_id) return undefined;
	if (!supervisor.agentId) {
		if (listener.session_path !== sessionPath || listener.session_path_asserted_at === null) return undefined;
		return { listener: { ...listener, runtime_instance_id: listener.runtime_instance_id } };
	}
	const supervisorAgent = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, supervisor.agentId) as { data: string } | undefined;
	if (!supervisorAgent) return undefined;
	const snapshot = parseStoredJsonObject(
		supervisorAgent.data,
		`multi_agent_agents:${sessionPath}#${supervisor.agentId}`,
	) as unknown as AgentSnapshot;
	if (snapshot.transcript?.sessionId !== supervisor.sessionId || !isActiveLifecycle(snapshot.lifecycle)) {
		return undefined;
	}
	return {
		listener: { ...listener, runtime_instance_id: listener.runtime_instance_id },
		supervisorAgentData: supervisorAgent.data,
	};
}

function supervisorSessionAuthorityIsCurrent(
	db: SqliteDatabase,
	sessionPath: string,
	supervisor: SupervisorRuntimeOwnership,
	expected: SupervisorSessionAuthoritySnapshot,
): boolean {
	const listener = db
		.prepare(
			`SELECT runtime_instance_id, session_path, session_path_asserted_at
			 FROM runtime_mailbox_listeners
			 WHERE recipient_session_id = ? AND recipient_agent_id_key = ? AND pid = ?`,
		)
		.get(supervisor.sessionId, supervisor.agentId ?? "", supervisor.processIdentity.pid) as
		| SupervisorSessionAuthoritySnapshot["listener"]
		| undefined;
	if (
		!listener ||
		listener.runtime_instance_id !== expected.listener.runtime_instance_id ||
		listener.session_path !== expected.listener.session_path ||
		listener.session_path_asserted_at !== expected.listener.session_path_asserted_at
	) {
		return false;
	}
	if (!supervisor.agentId) return expected.supervisorAgentData === undefined;
	const supervisorAgent = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, supervisor.agentId) as { data: string } | undefined;
	return supervisorAgent?.data === expected.supervisorAgentData;
}

function isRecoverableRuntimeLifecycle(value: unknown): boolean {
	return (
		value === "waiting_for_input" || value === "running" || value === "steering_pending" || value === "cancelling"
	);
}

function persistAcquiredRuntimeOwnership(
	db: SqliteDatabase,
	input: MultiAgentRuntimeOwnershipIdentity,
	processIdentityData: string,
): void {
	db.prepare(
		`INSERT INTO multi_agent_runtime_owners (
			session_path, agent_id, process_identity, owner_session_id, owner_agent_id
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(session_path, agent_id) DO UPDATE SET
			process_identity = excluded.process_identity,
			owner_session_id = excluded.owner_session_id,
			owner_agent_id = excluded.owner_agent_id`,
	).run(input.sessionPath, input.agentId, processIdentityData, input.owner.sessionId, input.owner.agentId);
}

function multiAgentRuntimeOwnershipFromInput(input: MultiAgentRuntimeOwnershipIdentity): MultiAgentRuntimeOwnership {
	return {
		agentId: input.agentId,
		owner: input.owner,
		processIdentity: input.processIdentity,
		sessionPath: input.sessionPath,
	};
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

function multiAgentRuntimeOwnershipFromRow(row: MultiAgentRuntimeOwnershipRow): MultiAgentRuntimeOwnership {
	return {
		agentId: row.agent_id,
		owner: { agentId: row.owner_agent_id, sessionId: row.owner_session_id ?? undefined },
		processIdentity: row.process_identity
			? parseProcessIdentity(row.process_identity, `multi_agent_runtime_owners:${row.session_path}#${row.agent_id}`)
			: undefined,
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
	model?: NonNullable<AgentSnapshot["model"]>,
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(
		controlDbPath,
		sessionPath,
		agentId,
		{ currentActivity, ...(model ? { model } : {}) },
		updatedAt,
		ownership,
	);
}

export function updateMultiAgentAgentModel(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	model: NonNullable<AgentSnapshot["model"]>,
	updatedAt: string,
	ownership: { ownerSessionId: string; processIdentity: ProcessIdentity },
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(controlDbPath, sessionPath, agentId, { model }, updatedAt, ownership);
}

export function updateMultiAgentAgentDisplayName(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	displayName: string,
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(controlDbPath, sessionPath, agentId, { displayName }, undefined);
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

type MultiAgentAgentMetadata =
	| Pick<AgentSnapshot, "displayName">
	| (Pick<AgentSnapshot, "currentActivity"> & Partial<Pick<AgentSnapshot, "model">>)
	| Pick<AgentSnapshot, "model">
	| Pick<AgentSnapshot, "lastActivity">
	| Pick<AgentSnapshot, "slot">
	| Pick<AgentSnapshot, "transcript">;

function permitsMultiAgentCurrentActivity(agent: Record<string, unknown>, metadata: MultiAgentAgentMetadata): boolean {
	return (
		!("currentActivity" in metadata) ||
		metadata.currentActivity === undefined ||
		agent.lifecycle === "running" ||
		agent.lifecycle === "steering_pending"
	);
}

const MULTI_AGENT_METADATA_UPDATE_MAX_ATTEMPTS = 3;

type MultiAgentAgentMetadataRow = {
	data: string;
	updated_at: string;
};

function updateMultiAgentAgentMetadata(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	metadata: MultiAgentAgentMetadata,
	updatedAt: string | undefined,
	activityOwnership?: { ownerSessionId: string; processIdentity: ProcessIdentity },
): AgentSnapshot | undefined {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_METADATA_UPDATE_MAX_ATTEMPTS; attempt += 1) {
			const row = db
				.prepare("SELECT data, updated_at FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(sessionPath, agentId) as MultiAgentAgentMetadataRow | undefined;
			if (!row) return undefined;
			const context = `multi_agent_agents:${sessionPath}#${agentId}`;
			const agent = parseStoredJsonObject(row.data, context);
			validatePersistedAgentPayload(agent, context);
			if (activityOwnership && !multiAgentActivityOwnershipMatches(db, sessionPath, agentId, activityOwnership)) {
				return undefined;
			}
			if (!permitsMultiAgentCurrentActivity(agent, metadata)) return undefined;
			const updated = { ...agent, ...metadata, updatedAt: updatedAt ?? agent.updatedAt } as AgentSnapshot;
			if (compareAndUpdateMultiAgentAgentMetadata(db, sessionPath, agentId, row, updated, activityOwnership)) {
				return updated;
			}
		}
		throw new Error(`Multi-agent metadata changed repeatedly while updating ${sessionPath}#${agentId}`);
	});
}

type MultiAgentMetadataWrite = {
	agentId: string;
	previous: MultiAgentAgentMetadataRow;
	serialized: string;
	sessionPath: string;
	updatedAt: string;
};

function compareAndUpdateMultiAgentAgentMetadata(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
	row: MultiAgentAgentMetadataRow,
	updated: AgentSnapshot,
	activityOwnership?: { ownerSessionId: string; processIdentity: ProcessIdentity },
): boolean {
	const write: MultiAgentMetadataWrite = {
		agentId,
		previous: row,
		serialized: JSON.stringify(updated),
		sessionPath,
		updatedAt: updated.updatedAt,
	};
	return activityOwnership
		? compareAndUpdateOwnedMultiAgentMetadata(db, write, activityOwnership)
		: compareAndUpdateMultiAgentMetadataSnapshot(db, write);
}

function compareAndUpdateMultiAgentMetadataSnapshot(db: SqliteDatabase, write: MultiAgentMetadataWrite): boolean {
	return (
		db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ? AND updated_at = ?`,
			)
			.run(
				write.serialized,
				write.updatedAt,
				write.sessionPath,
				write.agentId,
				write.previous.data,
				write.previous.updated_at,
			).changes === 1
	);
}

function compareAndUpdateOwnedMultiAgentMetadata(
	db: SqliteDatabase,
	write: MultiAgentMetadataWrite,
	ownership: { ownerSessionId: string; processIdentity: ProcessIdentity },
): boolean {
	return (
		db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ? AND updated_at = ?
				 AND EXISTS (
					SELECT 1 FROM multi_agent_runtime_owners
					WHERE session_path = ? AND agent_id = ? AND owner_session_id = ?
					AND owner_agent_id IS NULL AND process_identity = ?
				 )`,
			)
			.run(
				write.serialized,
				write.updatedAt,
				write.sessionPath,
				write.agentId,
				write.previous.data,
				write.previous.updated_at,
				write.sessionPath,
				write.agentId,
				ownership.ownerSessionId,
				serializeProcessIdentity(ownership.processIdentity),
			).changes === 1
	);
}

export function bootstrapMultiAgentAgent(controlDbPath: string, sessionPath: string, id: string, data: unknown): void {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`Invalid persisted agent payload at multi_agent_agents:${sessionPath}#${id}`);
	}
	validatePersistedAgentPayload(data as Record<string, unknown>, `multi_agent_agents:${sessionPath}#${id}`);
	const serialized = JSON.stringify(data);
	const updatedAt = new Date().toISOString();
	withControlDb(controlDbPath, (db) => upsertUnownedMultiAgentAgent(db, sessionPath, id, serialized, updatedAt));
}

function upsertUnownedMultiAgentAgent(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
	serializedAgent: string,
	updatedAt: string,
): void {
	if (readMultiAgentRuntimeOwnershipRow(db, sessionPath, agentId)) {
		throw new Error(`Generic agent upsert cannot mutate process-owned lifecycle row ${sessionPath}#${agentId}`);
	}
	const result = db
		.prepare(
			`INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at)
			 SELECT ?, ?, ?, ?
			 WHERE NOT EXISTS (
				SELECT 1 FROM multi_agent_runtime_owners WHERE session_path = ? AND agent_id = ?
			 )
			 ON CONFLICT(session_path, agent_id) DO UPDATE SET
				data = excluded.data,
				updated_at = excluded.updated_at
			 WHERE NOT EXISTS (
				SELECT 1 FROM multi_agent_runtime_owners WHERE session_path = ? AND agent_id = ?
			 )`,
		)
		.run(sessionPath, agentId, serializedAgent, updatedAt, sessionPath, agentId, sessionPath, agentId);
	if (result.changes !== 1) {
		throw new Error(`Generic agent upsert cannot mutate process-owned lifecycle row ${sessionPath}#${agentId}`);
	}
}

const MULTI_AGENT_MAILBOX_UPSERT_MAX_ATTEMPTS = 3;

type ParentRequestTargetSnapshot = {
	agentId: string;
	data: string;
};

type MultiAgentMailboxRowSnapshot = {
	data: string;
	updated_at: string;
};

type MultiAgentMailboxUpsertPlan = {
	existing: MultiAgentMailboxRowSnapshot | undefined;
	parentTarget: ParentRequestTargetSnapshot | undefined;
	serialized: string;
};

export function upsertMultiAgentMailboxMessage(
	controlDbPath: string,
	sessionPath: string,
	id: string,
	data: unknown,
): void {
	validateMailboxPayload(data, `multi_agent_mailbox_messages:${sessionPath}#${id}`);
	const createdAt = (data as Record<string, unknown>).createdAt;
	if (createdAt != null && isMailboxMessageExpired(createdAt, Date.now())) return;
	withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_MAILBOX_UPSERT_MAX_ATTEMPTS; attempt += 1) {
			const plan = prepareMultiAgentMailboxUpsert(db, sessionPath, id, data);
			if (
				isMailboxMessageExpired(
					parseStoredJsonObject(plan.serialized, `${sessionPath}#${id}`).createdAt,
					Date.now(),
				)
			)
				return;
			if (plan.existing?.data === plan.serialized) return;
			if (commitMultiAgentMailboxUpsert(db, sessionPath, id, plan)) return;
		}
		throw new Error(`Mailbox message changed repeatedly while updating ${sessionPath}#${id}`);
	});
}

function prepareMultiAgentMailboxUpsert(
	db: SqliteDatabase,
	sessionPath: string,
	id: string,
	data: unknown,
): MultiAgentMailboxUpsertPlan {
	const parentTarget = readParentRequestTargetSnapshot(db, sessionPath, data);
	const existing = readMultiAgentMailboxRowSnapshot(db, sessionPath, id);
	let serialized = JSON.stringify(data);
	if (existing) {
		const previous = parseJsonObject(existing.data);
		const next = parseJsonObject(serialized);
		if (!previous || !next || !sameMailboxMessageIdentity(previous, next, id)) {
			throw new Error(`Mailbox message ID collision: ${sessionPath}#${id}`);
		}
		serialized = JSON.stringify(mergeCanonicalMailboxUpdate(previous, next));
	} else if ((data as Record<string, unknown>).createdAt == null) {
		serialized = JSON.stringify({ ...(data as Record<string, unknown>), createdAt: new Date().toISOString() });
	}
	return { existing, parentTarget, serialized };
}

function commitMultiAgentMailboxUpsert(
	db: SqliteDatabase,
	sessionPath: string,
	id: string,
	plan: MultiAgentMailboxUpsertPlan,
): boolean {
	const createdAt = parseStoredJsonObject(plan.serialized, `${sessionPath}#${id}`).createdAt;
	const hasParentTarget = plan.parentTarget ? 1 : 0;
	const hasExisting = plan.existing ? 1 : 0;
	return withImmediateTransaction(db, () => {
		if (isMailboxMessageExpired(createdAt, Date.now())) return true;
		return (
			db
				.prepare(
					`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
				 SELECT ?, ?, ?, ?
				 WHERE (? = 0 OR EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND agent_id = ? AND data = ?
				 ))
				 AND ((? = 0 AND NOT EXISTS (
					SELECT 1 FROM multi_agent_mailbox_messages
					WHERE session_path = ? AND message_id = ?
				 )) OR (? = 1 AND EXISTS (
					SELECT 1 FROM multi_agent_mailbox_messages
					WHERE session_path = ? AND message_id = ? AND data = ? AND updated_at = ?
				 )))
				 ON CONFLICT(session_path, message_id) DO UPDATE SET
					data = excluded.data,
					updated_at = excluded.updated_at
				 WHERE ? = 1
				 AND multi_agent_mailbox_messages.data = ?
				 AND multi_agent_mailbox_messages.updated_at = ?`,
				)
				.run(
					sessionPath,
					id,
					plan.serialized,
					new Date().toISOString(),
					hasParentTarget,
					sessionPath,
					plan.parentTarget?.agentId ?? null,
					plan.parentTarget?.data ?? null,
					hasExisting,
					sessionPath,
					id,
					hasExisting,
					sessionPath,
					id,
					plan.existing?.data ?? null,
					plan.existing?.updated_at ?? null,
					hasExisting,
					plan.existing?.data ?? null,
					plan.existing?.updated_at ?? null,
				).changes === 1
		);
	});
}

function readMultiAgentMailboxRowSnapshot(
	db: SqliteDatabase,
	sessionPath: string,
	id: string,
): MultiAgentMailboxRowSnapshot | undefined {
	return db
		.prepare("SELECT data, updated_at FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?")
		.get(sessionPath, id) as MultiAgentMailboxRowSnapshot | undefined;
}

function mergeCanonicalMailboxUpdate(
	previous: Record<string, unknown>,
	next: Record<string, unknown>,
): Record<string, unknown> {
	const routing = {
		createdAt: previous.createdAt,
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
			.prepare(`SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?
				AND ${MAILBOX_CREATED_AT_MS_SQL} > ?`)
			.get(sessionPath, messageId, Date.now() - MAILBOX_MESSAGE_RETENTION_MS) as { data: string } | undefined;
		if (!row) {
			return undefined;
		}

		const parsed = parseJsonObject(row.data);
		return typeof parsed?.status === "string" ? parsed.status : undefined;
	});
}

/** IDs of unexpired mailbox rows still persisted for a session, read in one query. */
export function listLiveMultiAgentMailboxMessageIds(controlDbPath: string, sessionPath: string): Set<string> {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(`SELECT message_id FROM multi_agent_mailbox_messages WHERE session_path = ?
				AND ${MAILBOX_CREATED_AT_MS_SQL} > ?`)
			.all(sessionPath, Date.now() - MAILBOX_MESSAGE_RETENTION_MS) as Array<{ message_id: string }>;
		return new Set(rows.map((row) => row.message_id));
	});
}

export function markMultiAgentMailboxMessageDelivered(
	controlDbPath: string,
	sessionPath: string,
	messageId: string,
): boolean {
	return consumeRuntimeMailboxMessageByStoreRef(controlDbPath, { sessionPath, messageId }) === 1;
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
	status: "failed",
	error?: string,
): boolean {
	return withControlDb(controlDbPath, (db) => {
		const row = readCanonicalMailboxRowByStoreRef(db, { sessionPath, messageId });
		if (!row) return false;
		const parsed = parseJsonObject(row.data);
		if (!parsed || parsed.status !== "pending") return false;
		const now = new Date().toISOString();
		const updated = { ...parsed, status, updatedAt: now, ...(error === undefined ? {} : { error }) };
		const serialized = JSON.stringify(updated);
		return withImmediateTransaction(db, () =>
			compareAndWriteSerializedCanonicalMailboxPayload(db, row, serialized, now),
		);
	});
}

function readParentRequestTargetSnapshot(
	db: SqliteDatabase,
	sessionPath: string,
	data: unknown,
): ParentRequestTargetSnapshot | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const payload = data as Record<string, unknown>;
	if (payload.kind !== "parent_request") return undefined;
	const fromAgentId = requireStringField(payload, "fromAgentId", "parent_request");
	const toAgentId = requireStringField(payload, "toAgentId", "parent_request");
	const row = readParentRequestTargetRow(db, sessionPath, fromAgentId);
	const sender = row ? parseJsonObject(row.data) : undefined;
	if (!sender || sender.parentId !== toAgentId) {
		throw new Error(`Invalid parent request target at ${sessionPath}#${fromAgentId}`);
	}
	return row;
}

function readParentRequestTargetRow(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
): ParentRequestTargetSnapshot | undefined {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, agentId) as { data: string } | undefined;
	return row ? { agentId, data: row.data } : undefined;
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

const MULTI_AGENT_COUNTER_ALLOCATION_SQL: Record<MultiAgentCounterName, string> = {
	agent: `INSERT INTO multi_agent_counters_v2
		(session_path, next_agent_number, next_message_number, updated_at)
		VALUES (?, 2, 1, ?)
		ON CONFLICT(session_path) DO UPDATE SET
			next_agent_number = next_agent_number + 1,
			updated_at = excluded.updated_at
		RETURNING next_agent_number - 1 AS value`,
	message: `INSERT INTO multi_agent_counters_v2
		(session_path, next_agent_number, next_message_number, updated_at)
		VALUES (?, 1, 2, ?)
		ON CONFLICT(session_path) DO UPDATE SET
			next_message_number = next_message_number + 1,
			updated_at = excluded.updated_at
		RETURNING next_message_number - 1 AS value`,
};

export function allocateMultiAgentCounter(
	controlDbPath: string,
	sessionPath: string,
	counterName: MultiAgentCounterName,
): number {
	return withControlDb(controlDbPath, (db) => allocateMultiAgentCounterWithDb(db, sessionPath, counterName));
}

function allocateMultiAgentCounterWithDb(
	db: SqliteDatabase,
	sessionPath: string,
	counterName: MultiAgentCounterName,
): number {
	const row = db.prepare(MULTI_AGENT_COUNTER_ALLOCATION_SQL[counterName]).get(sessionPath, new Date().toISOString()) as
		| { value: number }
		| undefined;
	if (!row) throw new Error(`Multi-agent ${counterName} counter allocation returned no value for ${sessionPath}`);
	return row.value;
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

export function readMultiAgentAgents(
	controlDbPath: string,
	sessionPath: string,
	agentIds: readonly string[],
): AgentSnapshot[] {
	return withControlDb(controlDbPath, (db) => {
		const readAgent = db.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?");
		return agentIds.flatMap((agentId) => {
			const row = readAgent.get(sessionPath, agentId) as { data: string } | undefined;
			if (!row) return [];
			const context = `multi_agent_agents:${sessionPath}#${agentId}`;
			const agent = parseStoredJsonObject(row.data, context);
			validatePersistedAgentPayload(agent, context);
			return [agent as unknown as AgentSnapshot];
		});
	});
}

/** Non-terminal agents for a session; terminal history stays in SQLite. */
export function readActiveMultiAgentAgents(controlDbPath: string, sessionPath: string): AgentSnapshot[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`SELECT agent_id, data FROM multi_agent_agents
				 WHERE session_path = ?
				   AND (NOT json_valid(data) OR json_extract(data, '$.lifecycle') NOT IN ('completed', 'failed', 'aborted'))
				 ORDER BY rowid`,
			)
			.all(sessionPath) as Array<{ agent_id: string; data: string }>;
		return rows.map((row) => {
			const context = `multi_agent_agents:${sessionPath}#${row.agent_id}`;
			const agent = parseStoredJsonObject(row.data, context);
			validatePersistedAgentPayload(agent, context);
			return agent as unknown as AgentSnapshot;
		});
	});
}

export interface MultiAgentAgentKey {
	sessionPath: string;
	agentId: string;
}

/**
 * Deletes terminal agent rows whose detached output was removed, with their runtime-owner and
 * terminal-outbox rows. Rows that became non-terminal, have an undelivered terminal outbox row,
 * or parent a non-terminal agent are kept. Returns the number of deleted agent rows.
 */
export function deleteReleasedTerminalMultiAgentAgents(
	controlDbPath: string,
	keys: readonly MultiAgentAgentKey[],
): number {
	if (keys.length === 0) return 0;
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const activeParents = new Set(
				(db.prepare(ACTIVE_PARENT_KEYS_SQL).all() as Array<{ key: string }>).map((row) => row.key),
			);
			const releasable = db.prepare(RELEASABLE_TERMINAL_AGENT_SQL);
			const deleteRows = TERMINAL_AGENT_ROW_TABLES.map((table) =>
				db.prepare(`DELETE FROM ${table} WHERE session_path = ? AND agent_id = ?`),
			);
			let deleted = 0;
			for (const { agentId, sessionPath } of keys) {
				if (activeParents.has(`${sessionPath}\0${agentId}`) || !releasable.get(sessionPath, agentId)) continue;
				for (const statement of deleteRows) statement.run(sessionPath, agentId);
				deleted += 1;
			}
			return deleted;
		}),
	);
}

const ACTIVE_PARENT_KEYS_SQL = `SELECT DISTINCT session_path || char(0) || json_extract(data, '$.parentId') AS key
	FROM multi_agent_agents
	WHERE json_valid(data) AND json_extract(data, '$.parentId') IS NOT NULL
		AND json_extract(data, '$.lifecycle') NOT IN ('completed', 'failed', 'aborted')`;

const RELEASABLE_TERMINAL_AGENT_SQL = `SELECT 1 FROM multi_agent_agents AS agent
	WHERE agent.session_path = ? AND agent.agent_id = ? AND json_valid(agent.data)
		AND json_extract(agent.data, '$.lifecycle') IN ('completed', 'failed', 'aborted')
		AND NOT EXISTS (
			SELECT 1 FROM multi_agent_terminal_outbox AS outbox
			WHERE outbox.session_path = agent.session_path AND outbox.agent_id = agent.agent_id
				AND outbox.delivered_at IS NULL
		)`;

export function listDetachedArtifactAgentsUpdatedAtOrBefore(
	controlDbPath: string,
	updatedAtCutoff: string,
): DetachedArtifactAgentRecord[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`SELECT session_path, agent_id, data
				 FROM multi_agent_agents
				 WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.updatedAt') END <= ?
				   AND json_extract(data, '$.lifecycle') IN ('completed', 'failed', 'aborted')
				   AND EXISTS (
				     SELECT 1
				     FROM json_each(data, '$.result.fileRefs') AS file_ref
				     WHERE json_extract(file_ref.value, '$.label') IN ('Bash output', 'Pyrun output')
				   )
				 ORDER BY CASE WHEN json_valid(data) THEN json_extract(data, '$.updatedAt') END,
				          session_path,
				          agent_id`,
			)
			.all(updatedAtCutoff) as Array<{ agent_id: string; data: string; session_path: string }>;
		return rows.map((row) => {
			const context = `multi_agent_agents:${row.session_path}#${row.agent_id}`;
			const agent = parseStoredJsonObject(row.data, context);
			validatePersistedAgentPayload(agent, context);
			return { agent: agent as unknown as AgentSnapshot, sessionPath: row.session_path };
		});
	});
}

function readPersistedMultiAgentRows(
	db: SqliteDatabase,
	table: "multi_agent_agents" | "multi_agent_mailbox_messages",
	sessionPath: string,
): unknown[] {
	const mailbox = table === "multi_agent_mailbox_messages";
	const rows = db
		.prepare(`SELECT data FROM ${table} WHERE session_path = ?
		${mailbox ? `AND ${MAILBOX_CREATED_AT_MS_SQL} > ?` : ""} ORDER BY rowid`)
		.all(sessionPath, ...(mailbox ? [Date.now() - MAILBOX_MESSAGE_RETENTION_MS] : [])) as Array<{ data: string }>;
	return rows.map((row, index) => {
		const context = `${table}:${sessionPath}[${index}]`;
		const data = parseStoredJsonObject(row.data, context);
		if (mailbox) validateMailboxPayload(data, context);
		else validatePersistedAgentPayload(data, context);
		return data;
	});
}

export function readMultiAgentState(controlDbPath: string, sessionPath: string): MultiAgentPersistedState | undefined {
	return withControlDb(controlDbPath, (db) => {
		const counters = db
			.prepare(
				`
				SELECT next_agent_number, next_message_number
				FROM multi_agent_counters_v2 WHERE session_path = ?
				`,
			)
			.get(sessionPath) as { next_agent_number: number; next_message_number: number } | undefined;
		const agents = readPersistedMultiAgentRows(db, "multi_agent_agents", sessionPath);
		const mailboxMessages = readPersistedMultiAgentRows(db, "multi_agent_mailbox_messages", sessionPath);
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
