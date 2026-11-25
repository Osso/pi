export {
	claimPendingArchitectRequests,
	completeArchitectRequest,
	listPendingArchitectRequests,
	postArchitectRequest,
	renewArchitectRequestClaims,
} from "./session-control-db/architect.ts";
export {
	prepareControlDbForSelfRestart,
	retainControlDbConnection,
	withControlDb,
} from "./session-control-db/connection.ts";
export {
	claimCodexRestrictionRecovery,
	getControlDbPath,
	isKnownLocalSession,
	readRunningSessionIdByPid,
} from "./session-control-db/control-db-path.ts";
export { listDetachedArtifactAgentsUpdatedAtOrBefore } from "./session-control-db/detached-job-artifacts.ts";
export type { MultiAgentRuntimeOwnershipIdentity } from "./session-control-db/detached-job-finalization.ts";
export { finalizeDetachedJob } from "./session-control-db/detached-job-finalization.ts";
export {
	reconcileDeadDetachedAgentRuntimes,
	recoverDeadMultiAgentRuntime,
} from "./session-control-db/detached-job-recovery.ts";
export { normalizeSessionName, withImmediateTransaction } from "./session-control-db/helpers.ts";

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
export {
	registerRuntimeMailboxListener,
	SessionOpenElsewhereError,
} from "./session-control-db/runtime-mailbox-registration.ts";
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
	isSessionRootIndexed,
	listActiveSessionMetadata,
	listArchivedSessionMetadata,
	listEmptyMainSessionCandidates,
	listResumeSessionMetadata,
	listSessionMetadata,
	markSessionRootIndexed,
	readSessionGoal,
	readSessionMetadata,
	writeSessionGoal,
	writeSessionMetadata,
	writeSessionModel,
	writeSessionSandboxProfile,
	writeSessionThinkingLevel,
} from "./session-control-db/session-metadata.ts";
export type { SessionNameWriteResult } from "./session-control-db/session-relocation.ts";
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
	answerEscalatedQuestion,
	cancelSupervisorRequest,
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	hasPendingSupervisorApprovalRequest,
	listQuestionRequests,
	postSupervisorRequest,
	readSupervisorRequest,
	recoverSupervisorRequests,
	requeueSupervisorRequest,
	reviseQuestionAnswer,
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
	SupervisorQuestionAnswer,
	SupervisorReplyRoute,
	SupervisorRequest,
	SupervisorRequestKind,
	SupervisorRequestStatus,
	SupervisorResponse,
	WritableSessionMetadata,
} from "./session-control-db/types.ts";
