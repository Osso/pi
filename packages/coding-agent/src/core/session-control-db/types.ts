import type { AgentFileReference } from "../multi-agent-store.ts";

export type { AgentFileReference } from "../multi-agent-store.ts";

import type { RuntimeMailboxAcceptanceCheck } from "../runtime-mailbox-transcript.ts";

export const LIFECYCLE_PROTOCOL_SCHEMA_VERSION = 14;
export const CONTROL_DB_SCHEMA_VERSION = 15;

// Round Julian-day arithmetic to integer milliseconds so the 24-hour boundary is exact.
// Non-text, missing and unparseable timestamps sort before all valid creation dates.
export const MAILBOX_CREATED_AT_MS_SQL = `COALESCE(CASE WHEN json_valid(data) THEN
	CASE WHEN json_type(data, '$.createdAt') = 'text' THEN
	CAST(ROUND((julianday(json_extract(data, '$.createdAt')) - 2440587.5) * 86400000) AS INTEGER)
	END END, -8640000000000000)`;
export const MAILBOX_RETENTION_POLL_MS = 60_000;
/** How long user-facing question rows (both directions) stay in the store, whatever their status. */
export const QUESTION_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export interface IncomingControlMessage {
	id: number;
	content: string;
}

export type RuntimeMailboxMessageKind = "message" | "ask" | "reply" | "steer" | "parent_request" | "system";
export type RuntimeMailboxMessageStatus = "pending" | "claimed" | "failed";

export interface RuntimeMailboxAddress {
	sessionId: string;
	agentId: string | null;
}

export interface RuntimeMailboxMessage {
	id: number;
	recipient: RuntimeMailboxAddress;
	sender: RuntimeMailboxAddress;
	/** Set on messages imported by the host relay; replies need it as `toHost`. */
	senderHost?: string;
	kind: RuntimeMailboxMessageKind;
	body: string;
	/** Thread of the stored message; lifecycle notices use `agent-completed:`, `agent-failed:` and `agent-waiting-for-input:`. */
	threadId?: string;
	fileRefs?: AgentFileReference[];
	targetCheckpoint?: "next_model_call" | "after_tool_result" | "when_waiting";
	storeRef: RuntimeMailboxStoreRef;
	status: RuntimeMailboxMessageStatus;
	createdAt: string;
	updatedAt: string;
	claimedAt?: string;
	error?: string;
}

export interface RuntimeMailboxStoreRef {
	sessionPath: string;
	messageId: string;
}

export interface SharedChannelMessage {
	originHost?: string;
	originId?: number;
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

export type SupervisorRequestKind =
	| "approval_review"
	| "goal_completion_review"
	| "goal_idle_review"
	| "goal_set_review"
	| "question"
	| "supervisor_advisory";

/** `escalated`: a question the Supervisor passed to the user; it stays open until answered or withdrawn. */
export type SupervisorRequestStatus = "pending" | "claimed" | "escalated" | "completed" | "cancelled";

/** Who gave a stored question answer: the Supervisor, the user through the Supervisor UI or CLI, or the asker's own panel. */
export type QuestionAnswerSource = "supervisor" | "user" | "local";

export type SupervisorResponse =
	| { kind: "approve" | "reject"; reason: string }
	| { kind: "complete"; reason: string }
	| { kind: "continue"; instructions: string; reason: string }
	| { kind: "pause"; reason: string }
	| { kind: "wait"; reason: string }
	| { kind: "set"; objective: string; reason: string }
	| { kind: "advisory"; answer: string }
	| {
			kind: "answer";
			answers: Record<string, SupervisorQuestionAnswer>;
			/** Absent in historical records that did not store an answer source. */
			answeredBy?: QuestionAnswerSource;
			/** Set when the user revised an earlier answer. */
			revisedAt?: string;
	  }
	| { kind: "escalate"; reason: string }
	| { kind: "error"; reason: string };

/** The Supervisor's answer to one question of a `question` request, with why it applies. */
export interface SupervisorQuestionAnswer {
	answer: string;
	reason: string;
}

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
	replyTo?: SupervisorReplyRoute;
}

/**
 * Where the response to a Supervisor request goes: the asking runtime's mailbox, on `host` when the
 * request arrived through the relay from another machine. `requestId` correlates the reply with the caller.
 */
export interface SupervisorReplyRoute {
	host?: string;
	sessionId: string;
	agentId: string | null;
	requestId: string;
}

export interface PostSupervisorRequestInput {
	senderSessionId: string;
	projectId: string;
	kind: SupervisorRequestKind;
	payload: Record<string, unknown>;
	replyTo?: SupervisorReplyRoute;
	deadlineAt: string;
}

export interface EnqueueStoredRuntimeMailboxMessageInput extends EnqueueRuntimeMailboxMessageInput {
	message: unknown;
	updatedAt?: string;
}

export interface EnqueueRuntimeMailboxMessageInput {
	recipientHost?: string;
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
	modelProvider?: string;
	modelId?: string;
	thinkingLevel?: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	firstMessage: string;
	updatedAt: string;
}

export type WritableSessionMetadata = Omit<SessionMetadata, "goalJson" | "updatedAt">;

export interface ResumeSessionMetadataOptions {
	archived: boolean;
	cwd?: string;
	sessionPathPrefix?: string;
}

export type IncomingRow = {
	id: number;
	content: string;
	target_session_id: string | null;
};

export type RuntimeMailboxRow = {
	id: number;
	session_path: string;
	message_id: string;
	data: string;
	updated_at: string;
};

export type PromptHistoryRow = {
	content: string;
};

export type LastMessageRow = {
	role: string;
	content: string;
	updated_at: string;
};

export type RuntimeMailboxListenerRow = {
	pid: number;
	runtime_instance_id: string | null;
	session_path: string | null;
	session_path_asserted_at: string | null;
	updated_at: string;
};

export type RuntimeMailboxListedRow = {
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
	/** Recipient-transcript acceptance check; dead claims are recovered only when the owning session supplies it. */
	isMailboxStoreRefAccepted?: RuntimeMailboxAcceptanceCheck;
	isRuntimeProcessAlive?: (pid: number) => boolean;
	reconcileRuntimeReplacement?: boolean;
	runtimeInstanceId?: string;
}
