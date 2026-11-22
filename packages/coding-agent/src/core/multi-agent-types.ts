import type { ProcessIdentity } from "./runtime-process.ts";

export type AgentLifecycleState =
	| "running"
	| "waiting_for_input"
	| "steering_pending"
	| "cancelling"
	| "completed"
	| "failed"
	| "aborted";

export type TerminalAgentLifecycleState = "completed" | "failed" | "aborted";

export type SteeringCheckpoint = "next_model_call" | "after_tool_result" | "when_waiting";

export type MailboxMessageKind = "message" | "ask" | "reply" | "steer" | "parent_request" | "system";

export type MailboxMessageStatus = "pending" | "claimed" | "accepted" | "rejected" | "failed";

export interface AgentActivity {
	description: string;
	toolName?: string;
}

export type AgentCurrentActivity =
	| { phase: "thinking"; startedAt: string }
	| { phase: "tool"; startedAt: string; toolCallId: string; toolName: string; detail?: string };

export interface AgentCurrentActivityOwner {
	ownerSessionId: string;
	processIdentity: ProcessIdentity;
}

export interface AgentFileReference {
	path: string;
	label?: string;
}

export interface AgentResult {
	summary?: string;
	fileRefs?: AgentFileReference[];
	durationMs?: number;
	toolCallId?: string;
}

export interface AgentWorkerAdapter {
	adapter: "runtime" | "terminal" | "subprocess";
	handleId: string;
	cwd?: string;
	/** Tool call in the owning agent that spawned this detached runtime worker, if any. */
	toolCallId?: string;
}

export interface AgentTranscriptMetadata {
	sessionId: string;
	path?: string;
}

export interface AgentEventStreamMetadata {
	path: string;
	eventCount: number;
	truncated: boolean;
	byteLimit?: number;
}

export interface AgentNode {
	id: string;
	parentId: string | undefined;
	displayName: string;
	agentType: string;
	/** How the agent entered the store; absent means spawned as a child agent. */
	origin?: "attached" | "spawned";
	/** A read-only explore agent requested by its direct parent. */
	exploreConsultation?: true;
	lifecycle: AgentLifecycleState;
	revision: number;
	createdAt: string;
	updatedAt: string;
	cwd: string;
	worktree?: { path: string; branch?: string; base?: string };
	model?: { providerId: string; modelId: string; thinkingLevel?: string };
	account?: {
		id: string;
		budgetId?: string;
		providerFallback?: string[];
		tokenBudget?: { limit: number };
		concurrencyCap?: number;
		rateLimit?: { perMinute: number };
	};
	permission: { policy: string; inheritedFrom?: string; narrowed: boolean };
	slot?: { index: number; pinned: boolean };
	transcript?: AgentTranscriptMetadata;
	eventStream?: AgentEventStreamMetadata;
	worker?: AgentWorkerAdapter;
	/** True when a background job was detached from its waiting tool call; only detached jobs emit terminal mailbox notifications. */
	detached?: boolean;
	/** Persisted policy for terminal cleanup that must not notify the owning agent. */
	suppressTerminalNotification?: boolean;
	currentActivity?: AgentCurrentActivity;
	lastActivity?: AgentActivity;
	result?: AgentResult;
	error?: { message: string; code?: string };
}

export type AgentSnapshot = AgentNode;

export interface SpawnAgentInput {
	parentId?: string;
	displayName: string;
	agentType: string;
	origin?: AgentNode["origin"];
	cwd: string;
	permission: AgentNode["permission"];
	worktree?: AgentNode["worktree"];
	model?: AgentNode["model"];
	account?: AgentNode["account"];
	slot?: AgentNode["slot"];
	transcript?: AgentNode["transcript"];
	eventStream?: AgentNode["eventStream"];
	worker?: AgentNode["worker"];
}

export type SpawnChildAgentInput = Omit<SpawnAgentInput, "account" | "model" | "parentId"> & {
	account?: AgentNode["account"];
	model?: AgentNode["model"];
};

export type AttachSessionAgentInput = SpawnChildAgentInput & {
	transcript: AgentTranscriptMetadata;
};

export interface AgentMailboxMessage {
	id: string;
	threadId?: string;
	fromAgentId: string;
	toAgentId: string;
	kind: MailboxMessageKind;
	status: MailboxMessageStatus;
	createdAt: string;
	updatedAt: string;
	body?: string;
	fileRefs?: AgentFileReference[];
	targetCheckpoint?: SteeringCheckpoint;
	error?: string;
}

export interface SendSteeringInput {
	fromAgentId: string;
	body: string;
	targetCheckpoint?: SteeringCheckpoint;
	threadId?: string;
	fileRefs?: AgentFileReference[];
}

export interface ContactParentInput {
	body: string;
	threadId?: string;
	fileRefs?: AgentFileReference[];
}

export interface SendMailboxMessageInput {
	body: string;
	toAgentId: string;
	threadId?: string;
	fileRefs?: AgentFileReference[];
}

export type AgentLifecycleNotificationLifecycle = "completed" | "failed" | "waiting_for_input";

export const LIFECYCLE_NOTIFICATION_LIFECYCLES: readonly AgentLifecycleNotificationLifecycle[] = [
	"completed",
	"failed",
	"waiting_for_input",
];

export interface PendingLifecycleNotification {
	agentId: string;
	lifecycle: AgentLifecycleNotificationLifecycle;
	message: AgentMailboxMessage;
}

export interface AgentLifecycleNotificationInput {
	body: string;
	fileRefs?: AgentFileReference[];
	threadId: string;
}

export type AgentCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "not_found"; agentId: string }
	| { ok: false; error: "stale_revision"; current: AgentSnapshot }
	| { ok: false; error: "invalid_transition"; current: AgentSnapshot; requested: AgentLifecycleState };

export type SpawnChildAgentResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "parent_not_found"; parentId: string }
	| { ok: false; error: "permission_broadened"; parent: AgentSnapshot; requested: AgentNode["permission"] };

export type ParentContactResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; error: "not_found"; agentId: string }
	| { ok: false; error: "stale_revision"; current: AgentSnapshot };

export type MailboxMessageCommandResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; error: "not_found"; agentId: string }
	| { ok: false; error: "target_not_found"; current: AgentSnapshot; targetId: string }
	| { ok: false; error: "stale_revision"; current: AgentSnapshot }
	| { ok: false; error: "forbidden_target"; current: AgentSnapshot; target: AgentSnapshot };

export type AgentMetadataCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "not_found"; agentId: string }
	| { ok: false; error: "stale_revision"; current: AgentSnapshot; projection: MultiAgentProjectionSnapshot }
	| {
			ok: false;
			error: "slot_conflict";
			current: AgentSnapshot;
			occupant: AgentSnapshot;
			projection: MultiAgentProjectionSnapshot;
	  };

export type AgentTranscriptCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "not_found"; agentId: string };

export type AgentViewSelectionResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "not_found"; agentId: string };

export type ActiveAgentTargetSelectionResult =
	| AgentViewSelectionResult
	| { ok: false; error: "inactive"; agent: AgentSnapshot };

export interface MultiAgentStoreOptions {
	now?: () => string;
}

export type AgentLifecycleNotificationListener = (message: AgentMailboxMessage) => void;
export type AgentTransitionListener = (previous: AgentSnapshot, current: AgentSnapshot) => void;
export type AgentUpdateListener = (previous: AgentSnapshot, current: AgentSnapshot) => void;

export interface AgentSlotProjection {
	agentId: string;
	agent: AgentSnapshot;
	index: number;
	pinned: boolean;
	revision: number;
}

export interface AgentRowProjection {
	agentId: string;
	displayName: string;
	lifecycle: AgentLifecycleState;
	revision: number;
	active: boolean;
	selected: boolean;
	slotIndex?: number;
	workerAdapter?: AgentWorkerAdapter["adapter"];
}

export interface MultiAgentProjectionSnapshot {
	activeCount: number;
	agents: AgentSnapshot[];
	mailboxMessages: AgentMailboxMessage[];
	rows: AgentRowProjection[];
	selectedAgentId?: string;
	slots: AgentSlotProjection[];
}

export const COMPLETION_NOTIFICATION_THREAD_PREFIX = "agent-completed";
export const FAILED_NOTIFICATION_THREAD_PREFIX = "agent-failed";
export const WAITING_FOR_INPUT_NOTIFICATION_THREAD_PREFIX = "agent-waiting-for-input";
export const MAIN_THREAD_AGENT_ID = "main";
export const TERMINAL_STATES = new Set<AgentLifecycleState>(["completed", "failed", "aborted"]);
