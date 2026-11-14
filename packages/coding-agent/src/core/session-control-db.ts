import { hostname } from "node:os";
import { join } from "node:path";
import { getUserStateRoot } from "../config.ts";
import type { AgentSnapshot } from "./multi-agent-store.ts";
import { isSandboxProfileName, type SandboxProfileName } from "./permissions/presets.ts";
import { parseStoredJsonObject, validatePersistedAgentPayload } from "./session-control-db/codecs.ts";
import { parseProcessIdentity, withImmediateTransaction } from "./session-control-db/helpers.ts";
import type {
	RuntimeMailboxAddress,
	RuntimeMailboxListedRow,
	RuntimeMailboxMessage,
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
	compareAndDeleteCanonicalMailboxPayload,
	compareAndWriteSerializedCanonicalMailboxPayload,
	currentRuntimeOwnsMailboxAuthority,
	parseCanonicalMailboxPayload,
	RUNTIME_PROCESS_INSTANCE_ID,
	type RuntimeMailboxCandidate,
	readMultiAgentRuntimeOwnershipRow,
	readRuntimeMailboxAuthoritySnapshot,
	runtimeMailboxAuthoritySnapshotsEqual,
	runtimeMailboxClaimantIsLive,
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
	writeSessionHealthRow,
} from "./session-control-db/runtime-mailbox-registration.ts";

export { finalizeDetachedJob } from "./session-control-db/detached-job-finalization.ts";
export {
	reconcileDeadDetachedAgentRuntimes,
	recoverDeadMultiAgentRuntime,
} from "./session-control-db/detached-job-recovery.ts";
export {
	acquireAttachedRuntimeOwnership,
	createMultiAgentAttachment,
	readMultiAgentRuntimeOwnership,
} from "./session-control-db/multi-agent-attachment.ts";
export {
	consumeRuntimeMailboxMessageByStoreRef,
	getMultiAgentMailboxMessageStatus,
	listLiveMultiAgentMailboxMessageIds,
	markMultiAgentMailboxMessageDelivered,
	markMultiAgentMailboxMessageFailed,
	upsertMultiAgentMailboxMessage,
} from "./session-control-db/multi-agent-mailbox.ts";
export type { MultiAgentAgentKey, MultiAgentPersistedState } from "./session-control-db/multi-agent-state.ts";
export {
	allocateMultiAgentCounter,
	deleteReleasedTerminalMultiAgentAgents,
	readActiveMultiAgentAgents,
	readMultiAgentAgent,
	readMultiAgentAgents,
	readMultiAgentState,
	writeMultiAgentCounters,
} from "./session-control-db/multi-agent-state.ts";
export {
	listRuntimeMailboxListeners,
	readRuntimeMailboxListener,
	retireRuntimeMailboxListener,
} from "./session-control-db/runtime-mailbox-listeners.ts";
export { registerRuntimeMailboxListener } from "./session-control-db/runtime-mailbox-registration.ts";

import {
	type CommitMultiAgentSteeringDeliveryInput,
	persistMultiAgentSteeringDelivery,
	prepareMultiAgentSteeringDelivery,
} from "./session-control-db/multi-agent-steering-delivery.ts";

export {
	claimLatestIncomingMessage,
	completeIncomingMessage,
	enqueueIncomingMessage,
	failIncomingMessage,
	readIncomingMessageStatus,
} from "./session-control-db/incoming-control.ts";
export {
	updateMultiAgentAgentActivity,
	updateMultiAgentAgentCurrentActivity,
	updateMultiAgentAgentDisplayName,
	updateMultiAgentAgentModel,
	updateMultiAgentAgentSlot,
	updateMultiAgentAgentTranscript,
} from "./session-control-db/multi-agent-agent-updates.ts";

export type {
	AcquireMultiAgentRuntimeOwnershipInput,
	CreateFailedMultiAgentChildInput,
	CreateFailedMultiAgentChildResult,
	CreateMultiAgentChildWithRuntimeOwnershipInput,
	CreateMultiAgentChildWithRuntimeOwnershipResult,
	MultiAgentRuntimeOwnership,
} from "./session-control-db/multi-agent-child-creation.ts";
export {
	createFailedMultiAgentChild,
	createMultiAgentChildWithRuntimeOwnership,
} from "./session-control-db/multi-agent-child-creation.ts";
export {
	commitMultiAgentLifecycleMutation,
	commitMultiAgentTerminalMutation,
} from "./session-control-db/multi-agent-lifecycle.ts";
export { commitMultiAgentSteeringMutation } from "./session-control-db/multi-agent-steering.ts";
export {
	commitMultiAgentDetachMark,
	commitMultiAgentSteeringDelivery,
} from "./session-control-db/multi-agent-steering-delivery.ts";

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

export interface DetachedArtifactAgentRecord {
	sessionPath: string;
	agent: AgentSnapshot;
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
