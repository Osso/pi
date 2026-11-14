import { hostname } from "node:os";
import { join } from "node:path";
import { getUserStateRoot } from "../config.ts";
import { isMailboxMessageExpired, MAILBOX_MESSAGE_RETENTION_MS } from "./mailbox-retention.ts";
import {
	type AgentFileReference,
	type AgentMailboxMessage,
	type AgentSnapshot,
	isActiveLifecycle,
} from "./multi-agent-store.ts";
import { isSandboxProfileName, type SandboxProfileName } from "./permissions/presets.ts";
import { isProcessIdentityAlive, isSupersededRuntimeIdentity, type ProcessIdentity } from "./runtime-process.ts";
import {
	isNonterminalLifecycle,
	parseJsonObject,
	parseStoredJsonObject,
	requireStringField,
	validateMailboxPayload,
	validatePersistedAgentPayload,
} from "./session-control-db/codecs.ts";
import {
	parseProcessIdentity,
	TERMINAL_AGENT_ROW_TABLES,
	withImmediateTransaction,
} from "./session-control-db/helpers.ts";
import {
	type EnqueueStoredRuntimeMailboxMessageInput,
	type IncomingControlMessage,
	type IncomingRow,
	MAILBOX_CREATED_AT_MS_SQL,
	type RuntimeMailboxAddress,
	type RuntimeMailboxListedRow,
	type RuntimeMailboxListenerRow,
	type RuntimeMailboxMessage,
	type RuntimeMailboxStoreRef,
} from "./session-control-db/types.ts";
import type { SessionHealthRecord } from "./session-health.ts";
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

export { archiveSession, archiveSessionsOlderThan, unarchiveSession } from "./session-control-db/session-archive.ts";
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

export type { MultiAgentTerminalOutboxRecord } from "./session-control-db/terminal-outbox.ts";
export {
	claimMultiAgentTerminalOutbox,
	cleanupMultiAgentTerminalOutbox,
	deliverMultiAgentTerminalOutbox,
	failMultiAgentTerminalOutbox,
} from "./session-control-db/terminal-outbox.ts";

import { readCanonicalMailboxRowsForRecipient } from "./session-control-db/shared-channel.ts";

export {
	advanceSharedChannelCursor,
	hasPendingRuntimeCoordinationMessage,
	initializeSharedChannelCursorAtTail,
	isRuntimeCoordinationMailboxMessage,
	listSharedChannelMessagesAfter,
	postSharedChannelMessage,
	readSharedChannelCursor,
	readSharedChannelTail,
} from "./session-control-db/shared-channel.ts";

import {
	assertMailboxMessageFresh,
	compareAndDeleteCanonicalMailboxPayload,
	compareAndWriteSerializedCanonicalMailboxPayload,
	currentRuntimeOwnsMailboxAuthority,
	type MultiAgentRuntimeOwnershipRow,
	multiAgentRuntimeOwnershipRowsEqual,
	parseCanonicalMailboxPayload,
	prepareStoredRuntimeMailboxMessage,
	RUNTIME_PROCESS_INSTANCE_ID,
	type RuntimeMailboxCandidate,
	readCanonicalMailboxRowByStoreRef,
	readMultiAgentRuntimeOwnershipRow,
	readRuntimeMailboxAuthoritySnapshot,
	readRuntimeMailboxListenerRow,
	runtimeMailboxAuthoritySnapshotsEqual,
	runtimeMailboxClaimantIsLive,
	sameMailboxMessageIdentity,
} from "./session-control-db/runtime-mailbox-enqueue.ts";

export type { MultiAgentRuntimeOwnershipIdentity } from "./session-control-db/detached-job-finalization.ts";
export {
	enqueueRuntimeMailboxMessage,
	enqueueStoredRuntimeMailboxMessage,
	enqueueStoredRuntimeMailboxMessageInTransaction,
	getRuntimeProcessInstanceId,
	notifyRuntimeMailboxRecipient,
	recoverDeadRuntimeMailboxClaims,
} from "./session-control-db/runtime-mailbox-enqueue.ts";

import {
	readCanonicalMailboxRowById,
	runtimeMailboxMessageFromCanonicalRow,
} from "./session-control-db/runtime-mailbox-status.ts";

export {
	failRuntimeMailboxMessage,
	listRuntimeMailboxMessages,
	listRuntimeMailboxMessagesForSession,
	markRuntimeMailboxMessageDelivered,
	readRuntimeMailboxMessage,
	releaseRuntimeMailboxMessageClaim,
} from "./session-control-db/runtime-mailbox-status.ts";

import {
	assertRuntimeReplacementAllowed,
	type RuntimeMailboxRegistration,
	readRuntimeMailboxRegistrationSnapshot,
	readSessionHealthRow,
	type SessionHealthRow,
	sessionHealthFromRow,
	trustedRuntimeMailboxSessionPath,
	writeSessionHealthRow,
} from "./session-control-db/runtime-mailbox-registration.ts";

export {
	listRuntimeMailboxListeners,
	readRuntimeMailboxListener,
	retireRuntimeMailboxListener,
} from "./session-control-db/runtime-mailbox-listeners.ts";
export { registerRuntimeMailboxListener } from "./session-control-db/runtime-mailbox-registration.ts";

import {
	hasActivePersistedDescendant,
	type MultiAgentRuntimeOwnershipIdentity,
	runtimeOwnerMatches,
	serializeProcessIdentity,
	updateTerminalAgentIfCurrent,
} from "./session-control-db/detached-job-finalization.ts";

export { finalizeDetachedJob } from "./session-control-db/detached-job-finalization.ts";

import {
	isRecoverableRuntimeLifecycle,
	type SupervisorRuntimeOwnership,
} from "./session-control-db/detached-job-recovery.ts";

export {
	reconcileDeadDetachedAgentRuntimes,
	recoverDeadMultiAgentRuntime,
} from "./session-control-db/detached-job-recovery.ts";

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

export interface AcquireMultiAgentRuntimeOwnershipInput extends MultiAgentRuntimeOwnershipIdentity {
	nowIso: string;
}

export interface AcquireAttachedRuntimeOwnershipInput extends MultiAgentRuntimeOwnershipIdentity {
	nowIso: string;
	supervisor: SupervisorRuntimeOwnership;
}

export type AcquireAttachedRuntimeOwnershipResult =
	| { ok: true; agent: AgentSnapshot; ownership: MultiAgentRuntimeOwnership }
	| { ok: false; error: "agent_not_found" | "invalid_agent" | "ownership_held" | "mutation_mismatch" };

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
