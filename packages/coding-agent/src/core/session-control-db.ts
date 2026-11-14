import type { AgentSnapshot } from "./multi-agent-store.ts";
import { parseStoredJsonObject, validatePersistedAgentPayload } from "./session-control-db/codecs.ts";

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
	claimCodexRestrictionRecovery,
	getControlDbPath,
	isKnownLocalSession,
	readRunningSessionIdByPid,
} from "./session-control-db/control-db-path.ts";
export type { MultiAgentRuntimeOwnershipIdentity } from "./session-control-db/detached-job-finalization.ts";
export { finalizeDetachedJob } from "./session-control-db/detached-job-finalization.ts";
export {
	reconcileDeadDetachedAgentRuntimes,
	recoverDeadMultiAgentRuntime,
} from "./session-control-db/detached-job-recovery.ts";
export {
	claimLatestIncomingMessage,
	completeIncomingMessage,
	enqueueIncomingMessage,
	failIncomingMessage,
	readIncomingMessageStatus,
} from "./session-control-db/incoming-control.ts";
export {
	readLastMessage,
	readOrMigratePromptHistory,
	readPromptHistory,
	recordPromptHistoryEntry,
	writeLastMessage,
} from "./session-control-db/incoming-history.ts";
export {
	updateMultiAgentAgentActivity,
	updateMultiAgentAgentCurrentActivity,
	updateMultiAgentAgentDisplayName,
	updateMultiAgentAgentModel,
	updateMultiAgentAgentSlot,
	updateMultiAgentAgentTranscript,
} from "./session-control-db/multi-agent-agent-updates.ts";
export {
	acquireAttachedRuntimeOwnership,
	createMultiAgentAttachment,
	readMultiAgentRuntimeOwnership,
} from "./session-control-db/multi-agent-attachment.ts";
export { bootstrapMultiAgentAgent } from "./session-control-db/multi-agent-bootstrap.ts";
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
export { commitMultiAgentSteeringMutation } from "./session-control-db/multi-agent-steering.ts";
export {
	commitMultiAgentDetachMark,
	commitMultiAgentSteeringDelivery,
} from "./session-control-db/multi-agent-steering-delivery.ts";
export {
	assertMainSessionRuntimeAvailable,
	resolveOwnMainRuntimeCoordinationRecipient,
} from "./session-control-db/runtime-coordination.ts";
export {
	claimRuntimeMailboxMessages,
	deliverRuntimeMailboxMessage,
	hasPendingRuntimeMailboxMessage,
	readRuntimeMailboxMessageForDelivery,
	takeRuntimeMailboxMessagesForDelivery,
} from "./session-control-db/runtime-mailbox-delivery.ts";
export {
	enqueueRuntimeMailboxMessage,
	enqueueStoredRuntimeMailboxMessage,
	enqueueStoredRuntimeMailboxMessageInTransaction,
	getRuntimeProcessInstanceId,
	notifyRuntimeMailboxRecipient,
	recoverDeadRuntimeMailboxClaims,
} from "./session-control-db/runtime-mailbox-enqueue.ts";
export {
	listRuntimeMailboxListeners,
	readLiveRuntimeMailboxSessionAgentIds,
	readRuntimeMailboxListener,
	retireRuntimeMailboxListener,
} from "./session-control-db/runtime-mailbox-listeners.ts";
export { registerRuntimeMailboxListener } from "./session-control-db/runtime-mailbox-registration.ts";
export {
	failRuntimeMailboxMessage,
	listRuntimeMailboxMessages,
	listRuntimeMailboxMessagesForSession,
	markRuntimeMailboxMessageDelivered,
	readRuntimeMailboxMessage,
	releaseRuntimeMailboxMessageClaim,
} from "./session-control-db/runtime-mailbox-status.ts";
export { archiveSession, archiveSessionsOlderThan, unarchiveSession } from "./session-control-db/session-archive.ts";
export { listSessionHealth, readSessionHealth, writeSessionHealth } from "./session-control-db/session-health.ts";
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
export { readSessionSandboxProfile } from "./session-control-db/session-sandbox-profile.ts";
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
export type { MultiAgentTerminalOutboxRecord } from "./session-control-db/terminal-outbox.ts";
export {
	claimMultiAgentTerminalOutbox,
	cleanupMultiAgentTerminalOutbox,
	deliverMultiAgentTerminalOutbox,
	failMultiAgentTerminalOutbox,
} from "./session-control-db/terminal-outbox.ts";

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

export interface DetachedArtifactAgentRecord {
	sessionPath: string;
	agent: AgentSnapshot;
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
