export const MAX_GOAL_OBJECTIVE_CHARS = 10_000;

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { AgentSession, AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { DesktopNotification, DesktopNotifier } from "../../../src/core/desktop-notification.ts";
import type { ExtensionContext, ExtensionFactory, SessionShutdownEvent } from "../../../src/core/extensions/types.ts";
import type { LifecycleCoordinator, OwnedLifecycleCommandInput } from "../../../src/core/lifecycle-coordinator.ts";
import type { AgentMailboxMessage, AgentSnapshot, MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import type { RuntimeMailboxToolDelivery } from "../../../src/core/runtime-mailbox-acceptance.ts";
import type { CreateAgentSessionOptions } from "../../../src/core/sdk.ts";
import type { RuntimeMailboxAddress } from "../../../src/core/session-control-db.ts";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import { CHILD_DISABLED_AGENT_TOOL_NAMES, SUPERVISOR_ONLY_TOOL_NAMES } from "../../../src/core/tool-capabilities.ts";

export const checkpointSchema = Type.Union([
	Type.Literal("next_model_call"),
	Type.Literal("after_tool_result"),
	Type.Literal("when_waiting"),
]);

export const fileReferenceSchema = Type.Object({
	path: Type.String(),
	label: Type.Optional(Type.String()),
});

export const spawnAgentSchema = Type.Object({
	agentType: Type.Optional(Type.String()),
	context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("inherit")])),
	displayName: Type.Optional(
		Type.String({
			description: "Short task slug shown in the agent status list, e.g. fix-footer-count (max ~24 chars).",
		}),
	),
	parentId: Type.Optional(Type.String()),
	prompt: Type.String(),
});

export const listAgentsSchema = Type.Object(
	{
		parentId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const attachSessionAgentSchema = Type.Object({
	agentType: Type.Optional(Type.String()),
	displayName: Type.Optional(Type.String()),
	name: Type.Optional(Type.String({ description: "Session name; provide exactly one of name, path, or sessionId." })),
	parentId: Type.Optional(Type.String()),
	path: Type.Optional(
		Type.String({ description: "Session transcript path; provide exactly one of name, path, or sessionId." }),
	),
	prompt: Type.Optional(Type.String()),
	sessionId: Type.Optional(
		Type.String({ description: "Session ID or unique prefix; provide exactly one of name, path, or sessionId." }),
	),
});

export const waitAgentsSchema = Type.Object({}, { additionalProperties: false });

export const cancelAgentSchema = Type.Object({
	agentId: Type.String(),
	reason: Type.Optional(Type.String()),
});

export const steerAgentSchema = Type.Object({
	agentId: Type.String(),
	fileRefs: Type.Optional(Type.Array(fileReferenceSchema)),
	message: Type.String(),
	fromAgentId: Type.Optional(Type.String()),
	targetCheckpoint: Type.Optional(checkpointSchema),
});

export type SpawnAgentParams = Static<typeof spawnAgentSchema>;
export type AttachSessionAgentParams = Static<typeof attachSessionAgentSchema>;

export function requireSpawnAgentParams(params: unknown): asserts params is SpawnAgentParams {
	if (!params || typeof params !== "object") {
		throw new Error('spawn_agent context must be "fresh" or "inherit"');
	}
	const input = params as { context?: unknown; prompt?: unknown };
	if (input.context !== undefined && input.context !== "fresh" && input.context !== "inherit") {
		throw new Error('spawn_agent context must be "fresh" or "inherit"');
	}
	if (typeof input.prompt !== "string") {
		throw new Error("spawn_agent prompt must be a string");
	}
}
export type ListAgentsParams = Static<typeof listAgentsSchema>;
export type CancelAgentParams = Static<typeof cancelAgentSchema>;
export type SteerAgentParams = Static<typeof steerAgentSchema>;

export type ChildSessionModel = CreateAgentSessionOptions["model"];

export type ResolvedAgentProfile = {
	context?: "fresh" | "inherit";
	model?: ChildSessionModel;
	modelMetadata?: AgentSnapshot["model"];
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
};

export const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
]);
export const CHILD_AGENT_CONTROL_TOOL_NAMES = [
	"ask_questions",
	"contact_parent",
	"send_agent_message",
	"end_turn",
] as const;
export const CHILD_EXCLUDED_TOOL_NAMES = [
	...CHILD_DISABLED_AGENT_TOOL_NAMES,
	...SUPERVISOR_ONLY_TOOL_NAMES,
	"change_working_directory",
	// Child sessions cannot be named; offering the tool only produces refused calls.
	"set_session_name",
];
export const MAIN_THREAD_AGENT_ID = "main";
export const CANCELLATION_SETTLEMENT_TIMEOUT_MS = 5_000;
export const SUBAGENT_TERMINAL_CLEANUP_REASON = "Owning subagent reached a terminal path";
export const CRASH_RECOVERY_PROMPT =
	"Continue the conversation from where it left off without asking the user any further questions. Resume directly from the saved session context.";
export const MESSAGE_CONTENT_LIMIT = 2000;
export const RUNTIME_COORDINATION_POLL_INTERVAL_MS = 3_000;
export const WAIT_AGENT_SLICE_MS = 25 * 60_000;
export const CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE = "Agent orchestration is unavailable from child agent runtimes.";

export type AgentDesktopNotification = DesktopNotification;

export type AgentDesktopNotifier = DesktopNotifier;

export interface MultiAgentExtensionOptions {
	createAttachedSession?: AttachedSessionFactory;
	createChildSession?: ChildAgentSessionFactory;
	desktopNotifier?: AgentDesktopNotifier;
	runtimeHandles?: MultiAgentRuntimeHandles;
	selectAgentView?: (agentId: string) => boolean | undefined;
	onSessionMessageSent?: (input: { message: AgentMailboxMessage; toSessionId: string }) => void;
	store?: MultiAgentStore;
}

export interface ChildAgentDispatchInput {
	activeToolCallId?: string;
	agent: AgentSnapshot;
	context: "fresh" | "inherit";
	ctx: ExtensionContext;
	prompt: string;
	signal?: AbortSignal;
}

export interface ChildAgentSession {
	abort?(): void;
	dispose?(): void | Promise<void>;
	drainRuntimeCoordination?(): Promise<void>;
	/** Ended tool calls whose results the transcript has not received yet. */
	finishedToolCalls?: ReadonlyMap<string, Extract<AgentSessionEvent, { type: "tool_execution_end" }>>;
	messages: AgentMessage[];
	prompt(text: string): Promise<void>;
	subscribe?(listener: (event: AgentSessionEvent) => void): () => void;
	transcript?: AgentSnapshot["transcript"];
}

export type ChildAgentSessionFactory = (input: ChildAgentDispatchInput) => Promise<ChildAgentSession>;

export interface UnboundChildAgentSession
	extends Omit<
		ChildAgentSession &
			Pick<
				AgentSession,
				| "model"
				| "thinkingLevel"
				| "setModel"
				| "setThinkingLevel"
				| "modelRegistry"
				| "scopedModels"
				| "cycleModel"
			>,
		"prompt"
	> {
	prompt: AgentSession["prompt"];
	readonly agent: Pick<AgentSession["agent"], "waitForIdle">;
	readonly sessionManager: Pick<SessionManager, "getBranch">;
	extensionRunner: { emit(event: SessionShutdownEvent): Promise<unknown> };
	bindExtensions(bindings: Record<string, never>): Promise<void>;
}

export const productionChildSessionFactoryMarker = Symbol("productionChildSessionFactory");

export type ProductionChildAgentSessionFactory = ChildAgentSessionFactory & {
	[productionChildSessionFactoryMarker]: true;
};

export type GoalObjectiveValidation =
	| { objective: string; ok: true }
	| { length: number; ok: false; reason: "empty" | "too_long" };

export interface AttachedSessionDispatchInput extends Omit<ChildAgentDispatchInput, "context"> {
	sessionPath: string;
}

export type AttachedSessionFactory = (input: AttachedSessionDispatchInput) => Promise<ChildAgentSession>;

export interface ProductionChildAgentSessionFactoryOptions {
	agentDir?: string;
	browserAgentConfigRoot?: string;
	createSession: (options: CreateAgentSessionOptions) => Promise<{ session: UnboundChildAgentSession }>;
	createSessionManager: (
		cwd: string,
		sessionDir: string | undefined,
		options: { parentSession: string; isSubagent?: boolean; subagentName?: string },
	) => NonNullable<CreateAgentSessionOptions["sessionManager"]>;
	extensionFactories?: ExtensionFactory[] | (() => ExtensionFactory[]);
	multiAgentStore?: MultiAgentStore;
	sessionDir?: string;
}

export interface MultiAgentPiRequestHandler {
	(
		request: { method: string; params: unknown },
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		activeToolCallId?: string,
	): Promise<unknown> | unknown;
	dispose(): void;
}

export interface MainThreadSnapshot extends Record<string, unknown> {
	displayName: "Main thread";
	id: "main";
	lifecycle: "current";
	selected: true;
}

export interface AgentSelectionDetails extends Record<string, unknown> {
	agent: AgentSnapshot | MainThreadSnapshot;
}

export interface LastMessageDetails extends Record<string, unknown> {
	content?: string;
	entryId: string;
	role: string;
	text?: string;
	truncated?: true;
}

export interface AgentToolDetails extends Record<string, unknown> {
	agent: AgentSnapshot;
	descendants?: AgentSnapshot[];
	detached?: boolean;
	dispatched?: boolean;
	pendingMessages?: AgentMailboxMessage[];
	prompt?: string;
	reason?: string;
	terminal?: boolean;
}

export interface AgentListToolDetails {
	agents: AgentSnapshot[];
	activeCount: number;
}

export interface AgentSteerToolDetails {
	agent: AgentSnapshot;
	message: AgentMailboxMessage;
}

export interface ContactParentToolDetails {
	agent: AgentSnapshot;
	message: AgentMailboxMessage;
}

export type WaitNotificationsWake =
	| { kind: "agent"; agent: AgentSnapshot }
	| { kind: "cancelled" }
	| { kind: "coordination"; prompt?: string }
	| { kind: "error"; error: unknown }
	| { kind: "none" }
	| { kind: "timeout" }
	| { kind: "unavailable"; message: string }
	| { kind: "wake_up"; wakeUp: WaitAgentsWakeUp };

export type RuntimeCoordinationRecipient = {
	address: RuntimeMailboxAddress;
	controlDbPath: string;
};

export type PendingTerminalNotification = { agent: AgentSnapshot; message: AgentMailboxMessage };

export interface WaitAgentsWakeUp {
	agentId?: string;
	kind: "coordination" | "steering";
	coordinationPrompt?: string;
}

export interface WaitAgentsToolDetails {
	runtimeMailboxDelivery?: RuntimeMailboxToolDelivery;
	timedOut?: true;
	agent?: AgentSnapshot;
	agents?: AgentSnapshot[];
	message?: AgentMailboxMessage;
	messages?: AgentMailboxMessage[];
	wakeUp?: WaitAgentsWakeUp;
}

export interface SendAgentMessageToolDetails {
	agent: AgentSnapshot;
	message: AgentMailboxMessage;
}

export type BackgroundSessionHandles = Map<string, ChildAgentSession>;

export type ActiveAgentDispatches = Map<string, Promise<AgentSnapshot>>;

export interface OwnedAgentRuntime {
	abortController: AbortController;
	coordinator: LifecycleCoordinator;
	lifecycle: OwnedLifecycleCommandInput;
}

export interface MultiAgentRuntimeHandles {
	cancellationSettlementTimeoutMs?: number;
	latestModelRequestStartedAt?: number;
	dispatches: ActiveAgentDispatches;
	ownerships: Map<string, OwnedAgentRuntime>;
	sessions: BackgroundSessionHandles;
	waitWakeListeners: Set<(wakeUp: WaitAgentsWakeUp) => void>;
}
