/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolResult,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	ProviderRetryEvent,
	TextContent,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isCodexCybersecurityRestriction,
	isContextOverflow,
	isRetryableAssistantError,
	modelsAreEqual,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { requestSupervisorDecision } from "../supervisor/client.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { sleep } from "../utils/sleep.ts";
import { BackgroundCompactionState } from "./agent-session-background-compaction.ts";
import {
	assertStandaloneWorkerOptions,
	isAllowedSessionTool,
	type MultiAgentExecutionCapability,
	type MultiAgentRuntimeRole,
	validateMultiAgentRuntimeRole,
} from "./agent-session-capabilities.ts";
import {
	abortCompactionSummaryMaterialization,
	materializeCompactionSummary,
	updateCompactionSummary,
} from "./agent-session-compaction-summary.ts";
import { interruptSession } from "./agent-session-interrupt.ts";

export {
	assertStandaloneWorkerOptions,
	createMultiAgentExecutionCapability,
	type MultiAgentExecutionCapability,
	type MultiAgentRuntimeRole,
} from "./agent-session-capabilities.ts";

import {
	createAgentSessionDetachedJobLifecycleController,
	readHeadlessToolAutoDetachAfterMs,
	recordDetachedToolCallCompletion,
} from "./agent-session-detached-tools.ts";

export {
	buildDetachedToolCallCompletionEntry,
	DETACHED_TOOL_CALL_COMPLETION_CUSTOM_TYPE,
	type DetachedToolCallCompletionEntryData,
} from "./agent-session-detached-tools.ts";

import {
	bindSessionMutationTargetResolver,
	createInternalCommands,
	createViewedSessionCommandContext,
	recordHandledSlashCommandHistory,
} from "./agent-session-commands.ts";

import { CodexRestrictionRecoveryState } from "./agent-session-restriction-recovery.ts";
import { reviewToolApproval } from "./agent-session-tool-approval.ts";
import { callActiveTool } from "./agent-session-tool-call.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionResult,
	type CompactionSourceInfo,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	type MaterializeCompactionSummaryResult,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { compactionRetryCooldownMs, MAX_CONSECUTIVE_COMPACTION_FAILURES } from "./compaction-retry.ts";
import { estimateBranchContextTokens } from "./context-usage-estimate.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";

export { shouldContinueInterruptedSession } from "./agent-session-continuation.ts";

import type { DetachedJobLifecycleController } from "./detached-job-runner.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type AgentEndSessionContinuation,
	type CompactionReason,
	type ContextUsage,
	type ExtensionCommandContext,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ModelRequestEndEvent,
	type ModelRequestStartEvent,
	type ReplacedSessionContext,
	type ResolvedCommand,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	type ViewedSessionMutationTarget,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { ReadonlyFooterDataProvider } from "./footer-data-provider.ts";
import { LifecycleCoordinator } from "./lifecycle-coordinator.ts";
import { type BashExecutionMessage, type CustomMessage, createCompactionSummaryMessage } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { resolveModelScope, type ScopedModel } from "./model-resolver.ts";
import type {
	AgentCurrentActivityOwner,
	AgentLifecycleState,
	AgentSnapshot,
	MultiAgentStore,
	SteeringCheckpoint,
} from "./multi-agent-store.ts";
import { approvalPresetToBypassPermissions } from "./permissions/presets.ts";
import { PermissionRuleStore } from "./permissions/rule-store.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { calculateRetryDelayMs } from "./retry-delay.ts";
import { formatSharedChannelPrompt } from "./runtime-coordination-format.ts";
import {
	acceptRuntimeMailboxMessages,
	isRuntimeMailboxMessagePersisted,
	type RuntimeMailboxToolDelivery,
	readRuntimeMailboxToolDelivery,
	releaseUnacceptedRuntimeMailboxMessages,
} from "./runtime-mailbox-acceptance.ts";
import { createRuntimeMailboxUserMessage, deliverClaimedRuntimeMailboxMessages } from "./runtime-mailbox-delivery.ts";
import { isMailboxStoreRefAccepted } from "./runtime-mailbox-transcript.ts";
import {
	getRuntimeMessageMarker,
	isDuplicateTurnGuardMessage,
	markDuplicateTurnAssistantMessage,
	markDuplicateTurnGuardMessage,
	type RuntimeMessageMarker,
} from "./runtime-message-markers.ts";
import type { ProcessIdentity } from "./runtime-process.ts";

const BUILT_IN_COMPACTION_DISABLED_MESSAGE =
	"Built-in compaction is disabled; enable compaction or configure a compaction extension";

type PostAgentRunContinuation = "normal" | "queued";

interface ThinkingTimeoutDispatch {
	recoveryUsed: boolean;
	cancelled: boolean;
}

import {
	advanceSharedChannelCursor,
	cleanupMultiAgentTerminalOutbox,
	getControlDbPath,
	getRuntimeProcessInstanceId,
	hasPendingRuntimeMailboxMessage,
	initializeSharedChannelCursorAtTail,
	listSharedChannelMessagesAfter,
	type RuntimeMailboxAddress,
	type RuntimeMailboxMessage,
	readMultiAgentAgent,
	readMultiAgentRuntimeOwnership,
	readRuntimeMailboxListener,
	readSharedChannelTail,
	registerRuntimeMailboxListener,
	retainControlDbConnection,
	retireRuntimeMailboxListener,
	type SharedChannelMessage,
	takeRuntimeMailboxMessagesForDelivery,
	writeLastMessage,
} from "./session-control-db.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import { getLatestCompactionEntry } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS, type SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import {
	deliverTerminalOutboxProjections,
	isTerminalOutboxCleanupDue,
	terminalOutboxRetentionThreshold,
} from "./terminal-outbox-delivery.ts";

export { type ParsedSkillBlock, parseSkillBlock } from "./skill-block.ts";

import { summarizeToolArguments } from "./agent-activity-detail.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { STANDALONE_DISABLED_TOOL_NAMES } from "./tool-capabilities.ts";
import { ToolDetachRegistry } from "./tool-detach-registry.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import {
	createEndTurnToolDefinition,
	createToolDefinitionsForAvailableExecutables,
	DEFAULT_ACTIVE_TOOL_NAMES,
} from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

function estimateThresholdContextTokens(
	messages: AgentMessage[],
	assistantMessage: AssistantMessage,
	directContextTokens: number,
	thresholdTokens: number | undefined,
): number {
	if (thresholdTokens === undefined) return directContextTokens;
	const assistantIndex = messages.indexOf(assistantMessage);
	if (assistantIndex < 0) return directContextTokens;
	const trailingMessages = messages.slice(assistantIndex + 1);
	return directContextTokens + estimateMessagesTokens(trailingMessages);
}

const RUNTIME_MAILBOX_POLL_INTERVAL_MS = 30_000;
const RUNTIME_MAILBOX_HEARTBEAT_INTERVAL_MS = 60_000;
async function waitForHeadlessSessionStartRelease(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const releasePath = env.PI_HEADLESS_SESSION_START_RELEASE_PATH;
	if (releasePath === undefined) return;
	if (!releasePath) throw new Error("PI_HEADLESS_SESSION_START_RELEASE_PATH must be non-empty");
	writeFileSync(`${releasePath}.ready`, "ready");
	while (!existsSync(releasePath)) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function findAssistantMessageEntryIndex(entries: SessionEntry[], assistantMessage: AssistantMessage): number {
	const reverseIndex = [...entries]
		.reverse()
		.findIndex((entry) => entry.type === "message" && entry.message === assistantMessage);
	return reverseIndex === -1 ? -1 : entries.length - reverseIndex - 1;
}

function assistantMessagePrecedesCompaction(
	entries: SessionEntry[],
	assistantMessage: AssistantMessage,
	compactionEntry: CompactionEntry | null,
): boolean {
	if (!compactionEntry) return false;
	const compactionIndex = entries.lastIndexOf(compactionEntry);
	const assistantIndex = findAssistantMessageEntryIndex(entries, assistantMessage);
	if (assistantIndex !== -1) return assistantIndex < compactionIndex;
	return assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
}

const DUPLICATE_TURN_GUARD_PROMPT =
	"You repeated the same response. Stop looping. Call `end_turn` with a concise reason describing the current state.";

// Once this process has ever advertised its pid as a runtime mailbox listener, stray
// SIGUSR2 wakes can arrive at any later moment (stale listener rows, signals pending
// across a session switch). Reverting to the OS default disposition would terminate
// the process, so keep a permanent no-op handler installed.
let runtimeMailboxSignalKeepaliveInstalled = false;

function installRuntimeMailboxSignalKeepalive(): void {
	if (runtimeMailboxSignalKeepaliveInstalled || process.platform === "win32") {
		return;
	}
	runtimeMailboxSignalKeepaliveInstalled = true;
	process.on("SIGUSR2", () => {});
}

export function getAssistantMessageText(message: AssistantMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("");
}

type AgentMessageEvent = Extract<AgentEvent, { type: "message_start" | "message_update" | "message_end" }>;
type AgentSessionMessageEvent = AgentMessageEvent & { runtimeMessageMarker?: RuntimeMessageMarker };

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" } | AgentMessageEvent>
	| AgentSessionMessageEvent
	| { type: "agent_settled"; aborted: boolean }
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
			sessionContinuation?: AgentEndSessionContinuation;
	  }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "steering_message_queued" }
	| { type: "compaction_start"; reason: CompactionReason; sourceHint?: CompactionSourceInfo }
	| { type: "entry_appended"; entry: SessionEntry }
	/** Emitted after bash messages are appended to agent state and session storage. */
	| { type: "bash_messages_committed"; messages: readonly BashExecutionMessage[] }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: CompactionReason;
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	/** Provider-internal retry or transport fallback inside a single stream request. */
	| { type: "provider_stream_retry"; retry: ProviderRetryEvent };

function addRuntimeMessageMarker(event: AgentMessageEvent): AgentSessionMessageEvent {
	const runtimeMessageMarker = getRuntimeMessageMarker(event.message);
	return runtimeMessageMarker ? { ...event, runtimeMessageMarker } : event;
}

/** Display-only queue projection; delivery remains owned by Agent. */
export interface QueuedMessagePreview {
	readonly text: string;
	readonly inputSource?: InputSource;
	readonly customType?: string;
}

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export type SupervisorDecisionRequester = typeof requestSupervisorDecision;

const THINKING_PHASE_TIMEOUT_MS = 20 * 60 * 1000;
export interface AgentSessionConfig {
	/** Explicit standalone ephemeral worker runtime. */
	noSupervisor?: boolean;
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/** Optional MCP tool name used to approve or deny tool calls before native handlers. */
	permissionPromptTool?: string;
	/** Shared multi-agent store used for detached tool background jobs. */
	multiAgentStore?: MultiAgentStore;
	multiAgentRuntimeRole?: MultiAgentRuntimeRole;
	multiAgentExecutionCapability?: MultiAgentExecutionCapability;
	/** Current multi-agent runtime agent identity, when this session is running as a child agent. */
	multiAgentAgentId?: string;
	/** Parent runtime session ID for supervisor-directed messages from attached agents. */
	multiAgentParentSessionId?: string;
	/** Whether this runtime must have an explicit multi-agent identity to send agent messages. */
	multiAgentRequiresAgentId?: boolean;
	/** Disable inbound runtime mailbox and shared-channel delivery for dedicated observer runtimes. */
	disableRuntimeCoordinationInbound?: boolean;
	/** Notify an active wait_agent after signal-driven shared-channel delivery advances its cursor. */
	onSharedChannelMessageDelivered?: (prompt: string) => void;
	/** Global settings directory used for persistent permission rule writes. */
	agentDir?: string;
	/** Override resident Supervisor transport for isolated tests. */
	supervisorDecisionRequester?: SupervisorDecisionRequester;
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Override the thinking-phase deadline for deterministic tests. */
	thinkingPhaseTimeoutMs?: number;
}

export function bindAgentSessionMutationTargetResolver(
	session: AgentSession,
	resolver: () => ViewedSessionMutationTarget | undefined,
): void {
	bindSessionMutationTargetResolver(session, resolver);
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	footerData?: ReadonlyFooterDataProvider;
	mode?: ExtensionMode;
	controlDbPath?: string;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
	/** Internal hook used by interactive mode to display accepted user input before turn-context hooks run. */
	onUserMessagePrepared?: (message: AgentMessage) => void;
	/** Internal mailbox acceptance boundary, after prompt preflight. */
	acceptRuntimeMailbox?: (message?: AgentMessage) => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

interface CompactedContextEstimateInput {
	messages: AgentMessage[];
	summary: string;
	tokensBefore: number;
	durationMs: number | undefined;
	compactedResultTokens: number | undefined;
}

interface CompactedContextTokenEstimate {
	estimatedTokensAfter: number;
	keptFromPreviousContextTokens: number;
}

function estimateCompactedContextTokens(input: CompactedContextEstimateInput): CompactedContextTokenEstimate {
	const syntheticTokensAfter = estimateMessagesTokens(input.messages);
	const syntheticSummary = createCompactionSummaryMessage(
		input.summary,
		input.tokensBefore,
		new Date(0).toISOString(),
		{
			durationMs: input.durationMs,
		},
	);
	const syntheticSummaryTokens = estimateTokens(syntheticSummary);
	const compactedResultTokens = input.compactedResultTokens ?? syntheticSummaryTokens;
	// Kept tokens are the verbatim suffix retained from the previous context. Keep
	// that metric independent from provider-native compaction result size: remote
	// token counts can be larger than the synthetic summary estimate, but that does
	// not mean no previous-context messages were kept.
	const keptFromPreviousContextTokens = Math.max(0, syntheticTokensAfter - syntheticSummaryTokens);

	return {
		estimatedTokensAfter: keptFromPreviousContextTokens + compactedResultTokens,
		keptFromPreviousContextTokens,
	};
}

function readSharedChannelMessageSnapshot(
	controlDbPath: string,
	lastSeenId: number,
): { lastMessageId: number; messages: SharedChannelMessage[] } | undefined {
	const lastMessageId = readSharedChannelTail(controlDbPath);
	if (lastMessageId <= lastSeenId) {
		return undefined;
	}
	const messages: SharedChannelMessage[] = [];
	let pageCursor = lastSeenId;
	while (pageCursor < lastMessageId) {
		const page = listSharedChannelMessagesAfter(controlDbPath, pageCursor, undefined, lastMessageId);
		const lastPageMessage = page.at(-1);
		if (!lastPageMessage) {
			return undefined;
		}
		messages.push(...page);
		pageCursor = lastPageMessage.id;
	}
	return { lastMessageId, messages };
}

function isOwnSharedChannelMessage(message: SharedChannelMessage, recipient: RuntimeMailboxAddress): boolean {
	return (
		!message.originHost &&
		message.sender.sessionId === recipient.sessionId &&
		message.sender.agentId === recipient.agentId
	);
}

function isSubagentSharedChannelMessage(message: SharedChannelMessage): boolean {
	return message.sender.agentId !== null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isSessionBusyPromptError(error: unknown): boolean {
	return errorMessage(error).startsWith("Agent is already processing a prompt.");
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

// ============================================================================
// AgentSession Class
// ============================================================================

interface NavigateTreeOptions {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

type NavigateTreeResult = {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: BranchSummaryEntry;
};

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly noSupervisor: boolean;

	private _scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: QueuedMessagePreview[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: QueuedMessagePreview[] = [];
	/** Tracks the previous text-only assistant turn for deterministic loop detection. */
	private _lastAssistantTurnFingerprint: string | undefined;
	/** Prevents repeated guard injections until the assistant content or turn context changes. */
	private _duplicateTurnGuardInjected = false;
	/** Stops the current loop when the model repeats after receiving the guard. */
	private _duplicateTurnLoopDetected = false;
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Context-only custom messages sent during a run; appended once the turn's tool results are in (upstream #8537). */
	private _pendingCustomMessages: CustomMessage[] = [];
	/** User prompts held outside Agent queues, such as TUI input replay after abort. */
	private _externalUserInputReservations = 0;
	/** Serializes turn-start checks through the Agent core transition. */
	private _turnStartLockTail: Promise<void> = Promise.resolve();
	/** Whether an extension requested one continuation after session resume. */
	private _resumeContinuationRequested = false;
	private _beforeWorkingDirectoryRecoveryRun?: () => Promise<AgentSession | undefined>;
	private _afterWorkingDirectoryRecoveryTurn?: () => Promise<void>;

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _compactionCooldownUntil = 0;
	private _compactionFailureCount = 0;
	private _backgroundCompaction!: BackgroundCompactionState;
	private _compactionSummaryMaterializationAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private _lengthRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private readonly _toolDetachRegistry: ToolDetachRegistry | undefined;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _permissionPromptTool?: string;
	private _permissionRuleStore: PermissionRuleStore;
	private _agentDir: string;
	private readonly _controlDbPath: string;
	private readonly _supervisorDecisionRequester: SupervisorDecisionRequester;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionFooterData?: ReadonlyFooterDataProvider;
	private _extensionMode: ExtensionMode = "print";
	private _extensionControlDbPath?: string;
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _supervisorReviewCancellationHandler?: () => void;
	private _codexRestrictionRecovery!: CodexRestrictionRecoveryState;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	// Set by bindExtensions(): reload() restarts extensions only if the host started them.
	private _extensionsBound = false;
	private _runtimeMailboxPollTimer?: ReturnType<typeof setInterval>;
	private _runtimeMailboxControlDbPath?: string;
	private _runtimeMailboxControlDbRelease?: () => void;
	private _runtimeMailboxHeartbeatTimer?: ReturnType<typeof setInterval>;
	private _runtimeMailboxSignalHandler?: () => void;
	private _disposed = false;
	private _runtimeMailboxDrainPromise: Promise<boolean> | undefined;
	private _runtimeMailboxDrainMode: "prompt" | "steer" | undefined;
	private _sharedChannelDrainInProgress = false;
	private _sharedChannelDrainRequested = false;
	private _runtimeMailboxSteeringAgentIds = new Set<string>();
	private readonly _runtimeMailboxPendingTerminal = new Map<
		string,
		{ lifecycle: "completed" | "failed" | "aborted"; detail?: string }
	>();
	private _runtimeMailboxPendingTerminalUnsubscribe: (() => void) | undefined;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _multiAgentStore: MultiAgentStore | undefined;
	private readonly _multiAgentRuntimeRole: MultiAgentRuntimeRole | undefined;
	private readonly _detachedJobProcessIdentity = JSON.parse(getRuntimeProcessInstanceId()) as ProcessIdentity;
	private readonly _terminalOutboxClaimId = randomUUID();
	private _terminalOutboxLastCleanupAt: number | undefined;
	private _multiAgentAgentId: string | undefined;
	private readonly _multiAgentActiveTools = new Map<
		string,
		{ startedAt: string; toolCallId: string; toolName: string; detail?: string }
	>();
	private _multiAgentParentSessionId: string | undefined;
	private _multiAgentRequiresAgentId: boolean;
	private readonly _thinkingPhaseTimeoutMs: number;
	private _thinkingPhaseTimer: ReturnType<typeof setTimeout> | undefined;
	private _thinkingPhaseTimeoutError: Error | undefined;
	private _thinkingTimeoutDispatch: ThinkingTimeoutDispatch | undefined;
	private _disableRuntimeCoordinationInbound: boolean;
	private readonly _onSharedChannelMessageDelivered?: (prompt: string) => void;
	private _systemPromptOverride?: string;
	constructor(config: AgentSessionConfig) {
		assertStandaloneWorkerOptions(config);
		validateMultiAgentRuntimeRole(config);
		this.noSupervisor = config.noSupervisor ?? false;
		this._toolDetachRegistry = this.noSupervisor
			? undefined
			: new ToolDetachRegistry({ autoDetachAfterMs: readHeadlessToolAutoDetachAfterMs() });
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._permissionPromptTool = config.permissionPromptTool ?? this.settingsManager.getPermissionPromptTool();
		this._multiAgentRuntimeRole = config.multiAgentRuntimeRole;
		this._multiAgentAgentId = config.multiAgentAgentId;
		this._multiAgentParentSessionId = config.multiAgentParentSessionId;
		this._multiAgentRequiresAgentId = config.multiAgentRequiresAgentId ?? false;
		this._thinkingPhaseTimeoutMs = config.thinkingPhaseTimeoutMs ?? THINKING_PHASE_TIMEOUT_MS;
		this._disableRuntimeCoordinationInbound =
			this.noSupervisor || (config.disableRuntimeCoordinationInbound ?? false);
		this._onSharedChannelMessageDelivered = config.onSharedChannelMessageDelivered;
		this._multiAgentStore = config.multiAgentStore;
		this._agentDir = config.agentDir ?? getAgentDir();
		this._controlDbPath = this.sessionManager.getMetadataControlDbPath() ?? getControlDbPath();
		this._supervisorDecisionRequester = config.supervisorDecisionRequester ?? requestSupervisorDecision;
		this._permissionRuleStore = PermissionRuleStore.forSession(this.settingsManager, this._cwd, this._agentDir);
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this.sessionManager.setMetadataControlDbPath(this._controlDbPath);
		this._backgroundCompaction = new BackgroundCompactionState({
			getAgentStreamFn: () => this.agent.streamFn,
			settingsManager: this.settingsManager,
			getModel: () => this.model,
			getThinkingLevel: () => this.thinkingLevel,
			getSystemPrompt: () => this.agent.state.systemPrompt,
			getExtensionRunner: () => this._extensionRunner,
			getBranch: () => this.sessionManager.getBranch(),
			getSessionId: () => this.sessionManager.getSessionId(),
			getLeafId: () => this.sessionManager.getLeafId() ?? undefined,
			getModelRegistry: () => this._modelRegistry,
			getCompactionAuth: (model) => this._getCompactionRequestAuth(model),
			getCooldownUntil: () => this._compactionCooldownUntil,
			isAutoCompacting: () => this._autoCompactionAbortController !== undefined,
			isCompacting: () => this._compactionAbortController !== undefined,
			isDisposed: () => this._disposed,
			isObserver: () => this._multiAgentRuntimeRole === "observer",
			findLastAssistantMessage: () => this._findLastAssistantMessage(),
			getLatestCompactionEntry,
			assistantMessagePrecedesCompaction,
			withTurnStartLock: (callback) => this._withTurnStartLock(callback),
			getIsStreaming: () => this.isStreaming,
			getLastAssistantMessage: () => this._lastAssistantMessage,
			runAutoCompaction: (reason, willRetry) => this._runAutoCompaction(reason, willRetry),
			hasPendingMessages: () => this.hasPendingMessages(),
			hasQueuedMessages: () => this.agent.hasQueuedMessages(),
			isSessionCompacting: () => this.isCompacting,
			recordCompactionFailure: (message) => this._recordCompactionFailure(message),
		});
		this._codexRestrictionRecovery = new CodexRestrictionRecoveryState({
			getSessionManager: () => this.sessionManager,
			getSessionId: () => this.sessionId,
			getCwd: () => this._cwd,
			getModel: () => this.model,
			getMessages: () => this.agent.state.messages,
			getGoal: () => this.sessionManager.getSessionGoalJson(),
			isDisposed: () => this._disposed,
			isThinkingDispatchCancelled: () => this._thinkingTimeoutDispatch?.cancelled === true,
			isSupervisedMainSession: () =>
				!this.noSupervisor && !this._multiAgentAgentId && !this._multiAgentRequiresAgentId,
			hasPendingMessages: () => this.hasPendingMessages(),
			hasQueuedMessages: () => this.agent.hasQueuedMessages(),
			getControlDbPath: () => this._controlDbPath,
			getDecisionRequester: () => this._supervisorDecisionRequester,
			registerCancellation: (cancel) => this.registerSupervisorReviewCancellation(cancel),
			sendCustomMessage: (message) => this.sendCustomMessage(message),
			getActiveTools: () => this.agent.state.tools,
			replaceActiveTools: (tools) => {
				this.agent.state.tools = tools;
			},
			markThinkingRecoveryUsed: () => {
				if (this._thinkingTimeoutDispatch) this._thinkingTimeoutDispatch.recoveryUsed = true;
			},
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installAgentTurnStop();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		this._startRuntimeMailboxSignalWake();
		this._startRuntimeMailboxPolling();
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	private async _getRequiredRequestAuth(model: Model<Api>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers, env: result.env };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getCompactionRequestAuth(model: Model<Api>): Promise<{
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFn === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers, env: result.env } : {};
	}

	private async getCompactionSourceHint(
		reason: CompactionReason,
		willRetry: boolean,
	): Promise<CompactionSourceInfo | undefined> {
		if (!this.model) return undefined;

		if (this._extensionRunner.hasHandlers("session_compaction_source")) {
			const result = await this._extensionRunner.emit({ type: "session_compaction_source", reason, willRetry });
			if (result?.source) {
				return result.source;
			}
		}

		if (this._extensionRunner.hasHandlers("compaction")) {
			return undefined;
		}

		if (!this.settingsManager.getCompactionEnabled()) {
			return undefined;
		}

		return { type: "local", provider: this.model.provider, model: this.model.id };
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args, context }) => {
			this._clearThinkingPhaseDeadline();
			if (this.noSupervisor && STANDALONE_DISABLED_TOOL_NAMES.has(toolCall.name))
				return { block: true, reason: `Tool ${toolCall.name} is unavailable in standalone worker mode` };
			const runner = this._extensionRunner;
			const event = {
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				bypassPermissions: approvalPresetToBypassPermissions(this.settingsManager.getApprovalPreset()),
				input: args as Record<string, unknown>,
			} as const;
			return reviewToolApproval(event, context.messages, {
				extensionRunner: runner,
				getExtensionRunner: () => this._extensionRunner,
				settingsManager: this.settingsManager,
				getToolDefinitions: () => this._toolDefinitions,
				getToolRegistry: () => this._toolRegistry,
				permissionPromptTool: this._permissionPromptTool,
				permissionRuleStore: this._permissionRuleStore,
				getCwd: () => this._cwd,
				noSupervisor: this.noSupervisor,
				supervisorDecisionRequester: this._supervisorDecisionRequester,
				controlDbPath: this._controlDbPath,
				sessionManager: this.sessionManager,
				getMailboxAddress: () => ({ sessionId: this.sessionId, agentId: this._getRuntimeMailboxAgentId() }),
			});
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_result")) {
				return undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
			};
		};
	}

	private async _compactForNextTurn(turn: PrepareNextTurnContext): Promise<PrepareNextTurnContext> {
		const settings = this.settingsManager.getCompactionSettings();
		const usage = this.getContextUsage();
		const thresholdReached =
			settings.thresholdTokens !== undefined &&
			usage?.tokens != null &&
			shouldCompact(
				usage.tokens,
				usage.contextWindow,
				{ ...settings, enabled: true },
				this.model?.autoCompactionThreshold,
			);
		if (thresholdReached) {
			await this._checkCompaction(turn.message, false);
		} else if (this._hasReadyBackgroundCompaction()) {
			await this._runAutoCompaction("threshold", false);
		} else {
			if (usage?.tokens) this._backgroundCompaction.start(usage.tokens, usage.contextWindow);
			return turn;
		}
		return {
			...turn,
			context: { ...turn.context, messages: this.agent.state.messages.slice() },
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const currentTurn = await this._compactForNextTurn(turn);
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(currentTurn, signal);
			const previousContext = previousSnapshot?.context ?? currentTurn.context;
			if (turn.toolResults.length > 0) {
				await this._drainRuntimeCoordinationMessages({
					checkpoint: "after_tool_result",
					includeNextModelCall: true,
					triggerIfIdle: false,
				});
			}

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	private _installAgentTurnStop(): void {
		const previousShouldStopAfterTurn = this.agent.shouldStopAfterTurn;
		this.agent.shouldStopAfterTurn = async (turn) => {
			await this._afterWorkingDirectoryRecoveryTurn?.();
			return (
				this._codexRestrictionRecovery.hasValidation() ||
				this._extensionRunner.hasPreparedToolResultRelocation() ||
				this._duplicateTurnLoopDetected ||
				((await previousShouldStopAfterTurn?.(turn)) ?? false)
			);
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit in registration order; subscriber failures must not interrupt session operations. */
	private _emit(event: AgentSessionEvent): void {
		for (const listener of [...this._eventListeners]) {
			try {
				listener(event);
			} catch (error) {
				console.error(`Session event listener error (${event.type}):`, error);
			}
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: this.getSteeringMessages(),
			followUp: this.getFollowUpMessages(),
		});
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	private _removeStartedMessageFromQueue(event: AgentEvent): void {
		if (event.type !== "message_start") return;
		if (event.message.role === "custom") {
			if (event.message.customType !== "shared_channel" || typeof event.message.content !== "string") return;
			const content = event.message.content;
			const followUpIndex = this._followUpMessages.findIndex((message) => message.text === content);
			if (followUpIndex === -1) return;
			this._followUpMessages.splice(followUpIndex, 1);
			this._emitQueueUpdate();
			return;
		}
		if (event.message.role !== "user") return;
		const isInternalSteeringMessage = isDuplicateTurnGuardMessage(event.message);
		if (!isInternalSteeringMessage) this._resetDuplicateTurnGuard();
		this._overflowRecoveryAttempted = false;
		this._lengthRecoveryAttempted = false;
		const messageText = this._getUserMessageText(event.message);

		const steeringIndex = this._steeringMessages.findIndex((message) => message.text === messageText);
		if (steeringIndex !== -1) {
			this._steeringMessages.splice(steeringIndex, 1);
			this._emitQueueUpdate();
			return;
		}

		const followUpIndex = this._followUpMessages.findIndex((message) => message.text === messageText);
		if (followUpIndex !== -1) {
			this._followUpMessages.splice(followUpIndex, 1);
			this._emitQueueUpdate();
		}
	}

	private _trackCompletedAssistantMessage(message: AssistantMessage): void {
		this._lastAssistantMessage = message;
		this._writeLastAssistantControlMessage(message);
		this._trackDuplicateAssistantTurn(message);
		const overflowed = isContextOverflow(message, this.model?.contextWindow ?? 0);
		if (message.stopReason !== "error" && !overflowed) this._overflowRecoveryAttempted = false;
		if (message.stopReason !== "length") this._lengthRecoveryAttempted = false;
		if (message.stopReason === "error" || this._retryAttempt === 0) return;
		this._emit({ type: "auto_retry_end", success: true, attempt: this._retryAttempt });
		this._retryAttempt = 0;
	}

	private _getTerminalToolCallId(event: AgentEvent): string | undefined {
		if (event.type !== "message_end" || event.message.role !== "toolResult") return undefined;
		return event.message.toolCallId;
	}

	private async _persistCompletedMessage(
		event: Extract<AgentEvent, { type: "message_end" }>,
		originalToolCallId: string | undefined,
		mailboxDelivery: RuntimeMailboxToolDelivery | undefined,
	): Promise<void> {
		const { message } = event;
		const isInternalSteeringMessage = isDuplicateTurnGuardMessage(message);
		if (message.role === "custom") {
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		} else if (
			!isInternalSteeringMessage &&
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult")
		) {
			if (mailboxDelivery) {
				try {
					acceptRuntimeMailboxMessages(
						this.sessionManager,
						mailboxDelivery.controlDbPath,
						mailboxDelivery.messages,
						message,
					);
				} catch (error) {
					releaseUnacceptedRuntimeMailboxMessages(
						this.sessionManager,
						mailboxDelivery.controlDbPath,
						mailboxDelivery.messages,
					);
					throw error;
				}
			} else if (!isRuntimeMailboxMessagePersisted(message)) {
				this.sessionManager.appendMessage(message);
			}
		}
		if (originalToolCallId !== undefined) {
			await this._extensionRunner.deliverToolResultRelocation(originalToolCallId);
		}
		if (message.role === "assistant") this._trackCompletedAssistantMessage(message);
	}

	private _resetDuplicateTurnGuard(): void {
		this._lastAssistantTurnFingerprint = undefined;
		this._duplicateTurnGuardInjected = false;
		this._duplicateTurnLoopDetected = false;
	}

	private _markDuplicateAssistantMessageForPresentation(message: AssistantMessage): void {
		if (message.stopReason === "aborted" || message.stopReason === "error") return;
		if (message.content.some((item) => item.type === "toolCall")) return;

		const fingerprint = JSON.stringify({ text: getAssistantMessageText(message), stopReason: message.stopReason });
		if (fingerprint === this._lastAssistantTurnFingerprint) markDuplicateTurnAssistantMessage(message);
	}

	private _trackDuplicateAssistantTurn(message: AssistantMessage): void {
		if (message.stopReason === "aborted") {
			if (!this._duplicateTurnGuardInjected) this._resetDuplicateTurnGuard();
			return;
		}
		const hasToolCall = message.content.some((item) => item.type === "toolCall");
		if (hasToolCall || message.stopReason === "error") {
			this._resetDuplicateTurnGuard();
			return;
		}

		const fingerprint = JSON.stringify({ text: getAssistantMessageText(message), stopReason: message.stopReason });
		if (fingerprint !== this._lastAssistantTurnFingerprint) {
			this._lastAssistantTurnFingerprint = fingerprint;
			this._duplicateTurnGuardInjected = false;
			return;
		}
		if (this._duplicateTurnGuardInjected) {
			markDuplicateTurnAssistantMessage(message);
			this._duplicateTurnLoopDetected = true;
			return;
		}

		markDuplicateTurnAssistantMessage(message);
		this._duplicateTurnGuardInjected = true;
		const guardMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: DUPLICATE_TURN_GUARD_PROMPT }],
			inputSource: "extension",
			timestamp: Date.now(),
		};
		markDuplicateTurnGuardMessage(guardMessage);
		this._steerAgent(guardMessage);
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		const originalToolCallId = this._getTerminalToolCallId(event);
		const mailboxDelivery = event.type === "message_end" ? readRuntimeMailboxToolDelivery(event.message) : undefined;
		const sessionContinuation = this._readAgentEndSessionContinuation(event);
		if (event.type === "tool_execution_start") this._resetDuplicateTurnGuard();
		if (event.type === "message_end" && event.message.role === "assistant") {
			this._markDuplicateAssistantMessageForPresentation(event.message);
		}
		this._publishCurrentAgentActivity(event);
		this._removeStartedMessageFromQueue(event);
		await this._emitExtensionEvent(event, sessionContinuation);
		const listenerEvent =
			event.type === "agent_end"
				? {
						...event,
						willRetry: sessionContinuation === "cwd_relocation" || this._willRetryAfterAgentEnd(event),
						sessionContinuation,
					}
				: event.type === "message_start" || event.type === "message_update" || event.type === "message_end"
					? addRuntimeMessageMarker(event)
					: event;
		this._emit(listenerEvent);
		if (event.type === "message_end") {
			await this._persistCompletedMessage(event, originalToolCallId, mailboxDelivery);
			if (event.message.role === "assistant") {
				this._backgroundCompaction.startDuringToolTurn(event.message);
			}
		}
		if (event.type === "agent_end" && sessionContinuation === "cwd_relocation") {
			await this._extensionRunner.activateToolResultRelocation();
		}
	};

	private _getCurrentAgentActivityOwner(): AgentCurrentActivityOwner | undefined {
		if (!this._multiAgentParentSessionId) {
			return undefined;
		}
		return {
			ownerSessionId: this._multiAgentParentSessionId,
			processIdentity: this._detachedJobProcessIdentity,
		};
	}

	private _describeAgentModel(
		model: Model<Api> | undefined,
		thinkingLevel: ThinkingLevel,
	): NonNullable<AgentSnapshot["model"]> {
		if (!model) throw new Error(`Child agent ${this._multiAgentAgentId} has no effective model`);
		return { providerId: model.provider, modelId: model.id, thinkingLevel };
	}

	/** Publishes a child's model and effort before they take effect, so a rejected write leaves the child unchanged. */
	private _publishChildAgentModel(model: Model<Api> | undefined, thinkingLevel: ThinkingLevel): void {
		if (!this._multiAgentStore || !this._multiAgentAgentId) return;
		this._multiAgentStore.publishAgentModel(
			this._multiAgentAgentId,
			this._describeAgentModel(model, thinkingLevel),
			this._getCurrentAgentActivityOwner(),
		);
	}

	private _startThinkingPhaseDeadline(): void {
		if (this._multiAgentRuntimeRole === "observer" || this._thinkingPhaseTimeoutMs <= 0) return;
		this._clearThinkingPhaseDeadline();
		this._thinkingPhaseTimer = setTimeout(() => {
			this._thinkingPhaseTimer = undefined;
			const subject = this._multiAgentAgentId ? "Child agent" : "Main session";
			this._thinkingPhaseTimeoutError = new Error(`${subject} thinking phase exceeded 20 minutes`);
			this.agent.abort();
		}, this._thinkingPhaseTimeoutMs);
	}

	private _clearThinkingPhaseDeadline(): void {
		if (this._thinkingPhaseTimer) clearTimeout(this._thinkingPhaseTimer);
		this._thinkingPhaseTimer = undefined;
	}

	private _consumeThinkingPhaseTimeoutError(): Error | undefined {
		const error = this._thinkingPhaseTimeoutError;
		this._thinkingPhaseTimeoutError = undefined;
		return error;
	}

	private _updateThinkingPhaseDeadline(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this._startThinkingPhaseDeadline();
				return;
			case "tool_execution_start":
				if (this._multiAgentActiveTools.size === 1) this._clearThinkingPhaseDeadline();
				return;
			case "tool_execution_end":
				if (this._multiAgentActiveTools.size === 0) this._startThinkingPhaseDeadline();
				return;
			case "agent_end":
				this._clearThinkingPhaseDeadline();
		}
	}

	private _publishCurrentAgentActivity(event: AgentEvent): void {
		if (event.type === "agent_start" || event.type === "agent_end") this._multiAgentActiveTools.clear();
		if (event.type === "tool_execution_start") {
			this._multiAgentActiveTools.set(event.toolCallId, {
				startedAt: new Date(event.startedAt).toISOString(),
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				detail: summarizeToolArguments(event.args),
			});
		}
		if (event.type === "tool_execution_end") this._multiAgentActiveTools.delete(event.toolCallId);
		this._updateThinkingPhaseDeadline(event);

		const store = this._multiAgentStore;
		const agentId = this._multiAgentAgentId;
		if (!store || !agentId) return;
		const ownership = this._getCurrentAgentActivityOwner();

		switch (event.type) {
			case "agent_start":
				if (
					!store.publishAgentCurrentActivity(
						agentId,
						{ phase: "thinking", startedAt: new Date().toISOString() },
						ownership,
						this._describeAgentModel(this.model, this.thinkingLevel),
					)
				) {
					throw new Error(`Child agent ${agentId} model metadata update was rejected`);
				}
				break;
			case "tool_execution_start": {
				const activity = this._multiAgentActiveTools.get(event.toolCallId);
				if (this._multiAgentActiveTools.size === 1 && activity) {
					store.publishAgentCurrentActivity(agentId, { phase: "tool", ...activity }, ownership);
				}
				break;
			}
			case "tool_execution_end": {
				const nextTool = this._multiAgentActiveTools.values().next().value;
				const currentActivity = nextTool
					? { phase: "tool" as const, ...nextTool }
					: { phase: "thinking" as const, startedAt: new Date(event.finishedAt).toISOString() };
				store.publishAgentCurrentActivity(agentId, currentActivity, ownership);
				break;
			}
			case "agent_end":
				store.publishAgentCurrentActivity(agentId, undefined, ownership);
				break;
		}
	}

	private _completeRuntimeMailboxSteeringTurn(messages: AgentMessage[]): void {
		if (!this._multiAgentStore || this._runtimeMailboxSteeringAgentIds.size === 0) {
			return;
		}

		const lifecycle = this._runtimeMailboxSteeringLifecycle(messages);
		const detail = lifecycle === "aborted" ? undefined : this._runtimeMailboxSteeringDetail(messages);
		for (const agentId of this._runtimeMailboxSteeringAgentIds) {
			if (this._completeRuntimeMailboxSteeredAgent(agentId, lifecycle, detail)) continue;
			if (!this._isTerminalMultiAgentLifecycle(lifecycle)) continue;
			const hasActiveDescendants = this._multiAgentStore
				.listDescendants(agentId)
				.some((agent) => !this._isTerminalMultiAgentLifecycle(agent.lifecycle));
			if (hasActiveDescendants) this._deferRuntimeMailboxSteeredTerminal(agentId, lifecycle, detail);
		}
		this._runtimeMailboxSteeringAgentIds.clear();
	}

	private _completeRuntimeMailboxSteeredAgent(
		agentId: string,
		lifecycle: AgentLifecycleState,
		detail: string | undefined,
	): boolean {
		if (!this._multiAgentStore) {
			return false;
		}
		const current = this._multiAgentStore.getAgent(agentId);
		if (!current || this._isTerminalMultiAgentLifecycle(current.lifecycle)) {
			return true;
		}
		if (!this._isTerminalMultiAgentLifecycle(lifecycle)) return true;
		const result = detail && lifecycle === "completed" ? { summary: detail } : undefined;
		const error = lifecycle === "failed" ? { message: detail ?? "Runtime mailbox steering turn failed" } : undefined;
		if (!this._finalizeReservedMultiAgent(current, lifecycle, { error, result })) {
			return false;
		}
		return true;
	}

	private _deferRuntimeMailboxSteeredTerminal(
		agentId: string,
		lifecycle: "completed" | "failed" | "aborted",
		detail: string | undefined,
	): void {
		if (!this._multiAgentStore) return;
		this._runtimeMailboxPendingTerminal.set(agentId, { lifecycle, detail });
		if (this._runtimeMailboxPendingTerminalUnsubscribe) return;
		this._runtimeMailboxPendingTerminalUnsubscribe = this._multiAgentStore.subscribeAgentUpdates(() => {
			this._retryRuntimeMailboxSteeredTerminals();
		});
	}

	private _retryRuntimeMailboxSteeredTerminals(): void {
		const store = this._multiAgentStore;
		if (!store) return;
		for (const [agentId, pending] of this._runtimeMailboxPendingTerminal) {
			const hasActiveDescendants = store
				.listDescendants(agentId)
				.some((agent) => !this._isTerminalMultiAgentLifecycle(agent.lifecycle));
			if (hasActiveDescendants) continue;
			this._runtimeMailboxPendingTerminal.delete(agentId);
			if (!this._completeRuntimeMailboxSteeredAgent(agentId, pending.lifecycle, pending.detail)) {
				this._runtimeMailboxPendingTerminal.set(agentId, pending);
			}
		}
		if (this._runtimeMailboxPendingTerminal.size > 0) return;
		this._runtimeMailboxPendingTerminalUnsubscribe?.();
		this._runtimeMailboxPendingTerminalUnsubscribe = undefined;
	}

	private _finalizeReservedMultiAgent(
		agent: AgentSnapshot,
		terminalLifecycle: "completed" | "failed" | "aborted",
		metadata: { error?: { message: string }; result?: { summary: string } },
	): boolean {
		const store = this._multiAgentStore;
		const persistence = store?.getPersistenceTarget();
		if (!store || !persistence) return false;
		const ownership = readMultiAgentRuntimeOwnership(persistence.controlDbPath, persistence.sessionPath, agent.id);
		if (!ownership) return false;
		const coordinator = new LifecycleCoordinator({
			controlDbPath: persistence.controlDbPath,
			createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
			now: () => new Date().toISOString(),
			processIdentity: this._detachedJobProcessIdentity,
			sessionPath: persistence.sessionPath,
		});
		const finalized = coordinator.finalizeChild({
			agent,
			error: metadata.error,
			ownership,
			result: metadata.result,
			terminalLifecycle,
		});
		if (!finalized.ok) return false;
		this._drainTerminalOutboxProjections();
		return true;
	}

	private _isTerminalMultiAgentLifecycle(
		lifecycle: AgentLifecycleState,
	): lifecycle is "completed" | "failed" | "aborted" {
		return lifecycle === "completed" || lifecycle === "failed" || lifecycle === "aborted";
	}

	private _runtimeMailboxSteeringLifecycle(messages: AgentMessage[]): AgentLifecycleState {
		const assistant = this._lastRuntimeMailboxAssistant(messages);
		if (assistant?.stopReason === "aborted") {
			return "aborted";
		}
		if (assistant?.stopReason === "error") {
			return "failed";
		}
		return "completed";
	}

	/** A completed steering turn's reply text, or a failed one's provider error. */
	private _runtimeMailboxSteeringDetail(messages: AgentMessage[]): string | undefined {
		const assistant = this._lastRuntimeMailboxAssistant(messages);
		const text =
			assistant?.stopReason === "error" ? assistant.errorMessage : assistant && getAssistantMessageText(assistant);
		return text?.trim() || undefined;
	}

	private _lastRuntimeMailboxAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
		return [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
	}

	private _readAgentEndSessionContinuation(event: AgentEvent): AgentEndSessionContinuation | undefined {
		if (event.type !== "agent_end") return undefined;
		if (this._codexRestrictionRecovery.hasValidation()) return "codex_restriction_validation";
		return this._extensionRunner.hasPreparedToolResultRelocation() ? "cwd_relocation" : undefined;
	}

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		if (this._codexRestrictionRecovery.hasValidation()) {
			return this._codexRestrictionRecovery.willRetryAfterAgentEnd(this._lastAssistantMessage);
		}
		if (this._codexRestrictionRecovery.isAttemptActive()) return false;
		const dispatch = this._thinkingTimeoutDispatch;
		const recoveryAvailable = dispatch?.recoveryUsed === false && dispatch.cancelled === false;
		if (this._thinkingPhaseTimeoutError && recoveryAvailable) return true;
		for (const message of [...event.messages].reverse()) {
			if (message.role !== "assistant") {
				continue;
			}

			const assistant = message as AssistantMessage;
			const settings = this.settingsManager.getRetrySettings();
			return settings.enabled && this._retryAttempt < settings.maxRetries && this._isRetryableError(assistant);
		}
		return false;
	}

	/** Extract text content from a message */
	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	private _writeLastAssistantControlMessage(message: AssistantMessage): void {
		const content = getAssistantMessageText(message).trim();
		if (!content) return;

		writeLastMessage(this._controlDbPath, { role: "assistant", content });
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (const msg of [...messages].reverse()) {
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _shouldContinueAfterManualCompaction(messages: AgentMessage[]): boolean {
		let latestUserIndex = -1;
		let latestAssistantIndex = -1;
		let latestCompletedAssistantIndex = -1;

		for (const [reverseIndex, message] of [...messages].reverse().entries()) {
			if (latestUserIndex === -1 && message.role === "user") {
				latestUserIndex = messages.length - reverseIndex - 1;
			}
			if (latestAssistantIndex === -1 && message.role === "assistant") {
				latestAssistantIndex = messages.length - reverseIndex - 1;
				const assistant = message as AssistantMessage;
				if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
					return true;
				}
			}
			if (latestCompletedAssistantIndex === -1 && message.role === "assistant") {
				const assistant = message as AssistantMessage;
				if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
					latestCompletedAssistantIndex = messages.length - reverseIndex - 1;
				}
			}
			if (latestUserIndex !== -1 && latestAssistantIndex !== -1 && latestCompletedAssistantIndex !== -1) {
				break;
			}
		}

		return latestUserIndex !== -1 && latestCompletedAssistantIndex < latestUserIndex;
	}

	private _removeTrailingInterruptedAssistant(removeToolUseAssistant: boolean): void {
		const messages = this.agent.state.messages;
		const lastMessage = messages[messages.length - 1];
		if (lastMessage?.role !== "assistant") return;
		const assistant = lastMessage as AssistantMessage;
		if (
			assistant.stopReason === "aborted" ||
			assistant.stopReason === "error" ||
			(removeToolUseAssistant && assistant.stopReason === "toolUse")
		) {
			this.agent.state.messages = messages.slice(0, -1);
		}
	}

	private _continueAgentWithThinkingTimeout(
		dispatch: ThinkingTimeoutDispatch,
		processQueuedMessagesFirst = false,
	): Promise<void> {
		return this._runAgentWithThinkingTimeout(() => this.agent.continue({ processQueuedMessagesFirst }), dispatch);
	}

	private _isThinkingTimeoutDispatchActive(dispatch: ThinkingTimeoutDispatch): boolean {
		const ownsDispatch = this._thinkingTimeoutDispatch === dispatch;
		const stopped = dispatch.cancelled || this._disposed;
		return ownsDispatch && !stopped;
	}

	private async _runAgentWithThinkingTimeout(
		run: () => Promise<void>,
		dispatch: ThinkingTimeoutDispatch,
	): Promise<void> {
		try {
			await run();
		} catch (error) {
			const timeoutError = this._consumeThinkingPhaseTimeoutError();
			if (!timeoutError) throw error;
			await this._recoverThinkingTimeout(dispatch, timeoutError);
			return;
		}
		const timeoutError = this._consumeThinkingPhaseTimeoutError();
		if (timeoutError) await this._recoverThinkingTimeout(dispatch, timeoutError);
	}

	private async _recoverThinkingTimeout(dispatch: ThinkingTimeoutDispatch, timeoutError: Error): Promise<void> {
		if (!this._isThinkingTimeoutDispatchActive(dispatch)) return;
		if (dispatch.recoveryUsed) throw timeoutError;
		dispatch.recoveryUsed = true;
		this._emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 1,
			delayMs: 0,
			errorMessage: timeoutError.message,
		});
		await this._withTurnStartLock(async (release) => {
			if (!this._isThinkingTimeoutDispatchActive(dispatch)) return;
			this._removeTrailingInterruptedAssistant(false);
			const continuation = this._continueAgentWithThinkingTimeout(dispatch, true);
			release();
			await continuation;
		});
	}

	private async _continueAfterManualCompaction(
		removeToolUseAssistant: boolean,
		releaseTurnStart: () => void,
	): Promise<void> {
		try {
			if (this.isStreaming) {
				throw new Error("Agent is already processing. Wait for completion before continuing.");
			}

			this._removeTrailingInterruptedAssistant(removeToolUseAssistant);
			await this._prepareContinuationRun();
			const continuation = this._runAgentContinuation();
			releaseTurnStart();
			await continuation;
		} finally {
			this._flushPendingRunMessages();
		}
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(
		event: AgentEvent,
		sessionContinuation?: AgentEndSessionContinuation,
	): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "model_request_start") {
			const extensionEvent: ModelRequestStartEvent = { type: "model_request_start" };
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "model_request_end") {
			const extensionEvent: ModelRequestEndEvent = { type: "model_request_end" };
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages, sessionContinuation });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
			// The turn's tool results are persisted, so queued custom messages no longer split a call from its result.
			this._flushPendingCustomMessages();
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				this._replaceMessageInPlace(event.message, replacement);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/** Reconnect to agent events after _disconnectFromAgent(). Preserves all existing listeners. */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/** Remove all listeners and disconnect from agent. Call this when completely done with the session. */
	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._codexRestrictionRecovery.cancelPendingValidation();
		if (this._thinkingTimeoutDispatch) this._thinkingTimeoutDispatch.cancelled = true;
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortCompactionSummaryMaterialization();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._clearThinkingPhaseDeadline();
		this._backgroundCompaction.clearIdleTimer();
		this._thinkingPhaseTimeoutError = undefined;
		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._stopRuntimeMailboxPolling();
		this._stopRuntimeMailboxSignalWake();
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<Api> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	setWorkingDirectoryRecoveryHandlers(handlers: {
		beforeRun(): Promise<AgentSession | undefined>;
		afterTurn(): Promise<void>;
	}): void {
		this._beforeWorkingDirectoryRecoveryRun = handlers.beforeRun;
		this._afterWorkingDirectoryRecoveryTurn = handlers.afterTurn;
	}

	/** Request one continuation turn after the current session is resumed. */
	requestResumeContinuation(): void {
		this._resumeContinuationRequested = true;
	}

	/** Return and clear the pending one-shot resume continuation request. */
	consumeResumeContinuationRequest(): boolean {
		const requested = this._resumeContinuationRequested;
		this._resumeContinuationRequested = false;
		return requested;
	}

	/** Get the names of currently active tools. Returns the names of tools currently set on the agent. */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata. */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	private _callActiveTool(
		toolName: string,
		params: unknown,
		signal: AbortSignal | undefined,
		activeToolCallId?: string,
	): Promise<AgentToolResult<unknown>> {
		return callActiveTool({
			toolName,
			params,
			signal,
			activeToolCallId,
			noSupervisor: this.noSupervisor,
			activeTools: this.agent.state.tools,
			activeToolNames: this.getActiveToolNames(),
			toolRegistry: this._toolRegistry,
			systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
			messages: this.agent.state.messages,
			model: this.model,
			toolHooks: this.agent,
		});
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		this._codexRestrictionRecovery.markToolsReplaced();
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Whether compaction, summary materialization, or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._compactionSummaryMaterializationAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;
		const rulesContent = this._resourceLoader.getRulesContent();

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			rulesContent,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _withTurnStartLock<T>(callback: (release: () => void) => Promise<T>): Promise<T> {
		const previous = this._turnStartLockTail;
		let releaseTail!: () => void;
		this._turnStartLockTail = new Promise<void>((resolve) => {
			releaseTail = resolve;
		});
		await previous;

		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			releaseTail();
		};

		try {
			return await callback(release);
		} finally {
			release();
		}
	}

	private async _queuePromptForStreaming(
		text: string,
		images: ImageContent[] | undefined,
		streamingBehavior: PromptOptions["streamingBehavior"],
		inputSource?: InputSource,
		acceptRuntimeMailbox?: PromptOptions["acceptRuntimeMailbox"],
	): Promise<void> {
		if (acceptRuntimeMailbox) {
			const message = createRuntimeMailboxUserMessage(text, inputSource ?? "extension", images);
			this._steerAgent(message);
			acceptRuntimeMailbox(message);
			return;
		}
		if (!streamingBehavior) {
			throw new Error(
				"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
			);
		}
		if (streamingBehavior === "followUp") {
			await this._queueFollowUp(text, images, inputSource);
		} else {
			await this._queueSteer(text, images, inputSource);
		}
	}

	/**
	 * Runs before_agent_start for a new run and installs its system prompt, or the base prompt. Every run start calls
	 * it, so a run never reuses an earlier run's additions or lacks them. `prompt` is empty for runs that no user
	 * prompt started (custom messages, continuations). Returns the custom messages the handlers added.
	 */
	private async _applyBeforeAgentStart(prompt: string, images?: ImageContent[]): Promise<CustomMessage[]> {
		const result = await this._extensionRunner.emitBeforeAgentStart(
			prompt,
			images,
			this._baseSystemPrompt,
			this._baseSystemPromptOptions,
		);
		this._systemPromptOverride = result?.systemPrompt;
		this.agent.state.systemPrompt = result?.systemPrompt ?? this._baseSystemPrompt;
		return (result?.messages ?? []).map((message) => ({ ...message, role: "custom", timestamp: Date.now() }));
	}

	/** Prepares a continuation run: applies before_agent_start and queues the handler messages for the run. */
	private async _prepareContinuationRun(): Promise<void> {
		for (const message of await this._applyBeforeAgentStart("")) this.agent.steer(message);
	}

	private _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		return this._runThinkingTimeoutDispatch(() => this.agent.prompt(messages));
	}

	private _runAgentContinuation(): Promise<void> {
		return this._runThinkingTimeoutDispatch(() => this.agent.continue());
	}

	private async _runThinkingTimeoutDispatch(run: () => Promise<void>): Promise<void> {
		const dispatch: ThinkingTimeoutDispatch = { recoveryUsed: false, cancelled: false };
		this._thinkingTimeoutDispatch = dispatch;
		this._thinkingPhaseTimeoutError = undefined;
		let finalError: string | undefined;
		try {
			await this._runAgentWithThinkingTimeout(run, dispatch);
			await this._continuePostAgentRuns(dispatch);
		} catch (error) {
			finalError = errorMessage(error);
			throw error;
		} finally {
			this._finishThinkingTimeoutDispatch(dispatch, finalError);
		}
	}

	private _finishThinkingTimeoutDispatch(dispatch: ThinkingTimeoutDispatch, finalError?: string): void {
		if (dispatch.recoveryUsed) {
			const cancellationError = dispatch.cancelled ? "Retry cancelled" : undefined;
			const reportedError = cancellationError ?? finalError ?? this._findLastAssistantMessage()?.errorMessage;
			this._emit({
				type: "auto_retry_end",
				success: reportedError === undefined,
				attempt: 1,
				finalError: reportedError,
			});
		}
		if (this._thinkingTimeoutDispatch !== dispatch) return;
		this._codexRestrictionRecovery.cancelValidationForTurn();
		this._codexRestrictionRecovery.resetAttempt();
		this._thinkingTimeoutDispatch = undefined;
		this._clearThinkingPhaseDeadline();
		this._systemPromptOverride = undefined;
		this._flushPendingRunMessages();
		this._scheduleIdleCompaction();
		void this._extensionRunner.emit({ type: "agent_settled" });
		this._emit({
			type: "agent_settled",
			aborted:
				dispatch.cancelled ||
				(finalError === undefined && this._findLastAssistantMessage()?.stopReason === "aborted"),
		});
	}

	private async _continuePostAgentRuns(dispatch: ThinkingTimeoutDispatch): Promise<void> {
		if (this._disposed || dispatch.cancelled) return;
		while (
			await this._withTurnStartLock(async (release) => {
				if (this.isStreaming || !this._isThinkingTimeoutDispatchActive(dispatch)) return false;
				const continuationKind = await this._handlePostAgentRun();
				if (continuationKind === undefined || !this._isThinkingTimeoutDispatchActive(dispatch)) {
					return false;
				}
				const continuation = this._continueAgentWithThinkingTimeout(dispatch, continuationKind === "queued");
				release();
				await continuation;
				return true;
			})
		) {
			// Continue until post-run compaction, retry, or queued coordination work is drained.
		}
	}

	private validateModelAuthentication(): void {
		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		if (this._modelRegistry.hasConfiguredAuth(this.model)) {
			return;
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${this.model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${this.model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
	}

	private _finishExhaustedRetry(message: AssistantMessage): void {
		if (message.stopReason !== "error" || this._retryAttempt === 0) return;
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt: this._retryAttempt,
			finalError: message.errorMessage,
		});
		this._retryAttempt = 0;
	}

	private async _selectPostAgentRunContinuation(): Promise<PostAgentRunContinuation | undefined> {
		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		if (this.agent.hasQueuedMessages()) return "queued";
		// Ready coordination is queued as an agent follow-up, so it must start the next request instead
		// of a bare continuation that resends the ended transcript.
		const coordinationMessageReady = await this._drainRuntimeCoordinationMessages({
			checkpoint: "next_model_call",
			triggerIfIdle: false,
		});
		return coordinationMessageReady ? "queued" : undefined;
	}

	private async _handlePostAgentRun(): Promise<PostAgentRunContinuation | undefined> {
		if (this._disposed) return undefined;
		const message = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!message) return undefined;
		const restrictionAttempt = this._codexRestrictionRecovery.isAttemptActive();
		this._codexRestrictionRecovery.resetAttempt();
		if (this._codexRestrictionRecovery.hasValidation()) {
			const execute = await this._codexRestrictionRecovery.finishValidationFor(message);
			return execute ? "normal" : this._selectPostAgentRunContinuation();
		}
		if (isCodexCybersecurityRestriction(message)) {
			const rescope = await this._codexRestrictionRecovery.prepareRecovery(message);
			this._finishExhaustedRetry(message);
			return rescope ? "normal" : this._selectPostAgentRunContinuation();
		}
		// The one recovery attempt gets no retry or overflow resend.
		if (restrictionAttempt) {
			this._finishExhaustedRetry(message);
			return this._selectPostAgentRunContinuation();
		}
		if (this._isRetryableError(message) && (await this._prepareRetry(message))) return "normal";
		this._finishExhaustedRetry(message);
		if (await this._checkCompaction(message)) return "normal";
		return this._selectPostAgentRunContinuation();
	}

	/**
	 * Continue the agent from the current transcript without adding a user message.
	 * @throws Error if streaming, no model is selected, or no API key is available
	 */
	async continue(): Promise<void> {
		if (!this.isStreaming) {
			const replacement = await this._beforeWorkingDirectoryRecoveryRun?.();
			if (replacement && replacement !== this) {
				await replacement.continue();
				return;
			}
		}
		await this._withTurnStartLock(async (release) => {
			if (this.isStreaming) {
				throw new Error("Agent is already processing. Wait for completion before continuing.");
			}

			this._flushPendingRunMessages();

			const lastMessage = this.messages[this.messages.length - 1];
			if (!lastMessage) {
				return;
			}

			this.validateModelAuthentication();

			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}
			await this._prepareContinuationRun();

			if (this.isStreaming) {
				throw new Error("Agent is already processing. Wait for completion before continuing.");
			}

			const continuation = this._runAgentContinuation();
			release();
			try {
				await continuation;
			} finally {
				this._completeRuntimeMailboxSteeringTurn(this.messages);
			}
		});
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		// Registered commands must remain available while recovery or compaction owns the start lock.
		const command = this._tryExecuteExtensionCommand(text, options);
		if (command) {
			await command;
			return;
		}
		// Reserve the start before cwd recovery yields, so idle coordination cannot overtake this input.
		const prompted = await this._withTurnStartLock((release) =>
			this._promptWithWorkingDirectoryRecovery(text, options, release),
		);
		if (prompted) await this._drainRuntimeCoordinationMessages({ triggerIfIdle: true });
	}

	private async _promptWithWorkingDirectoryRecovery(
		text: string,
		options: PromptOptions | undefined,
		release: () => void,
	): Promise<boolean> {
		if (!this.isStreaming) {
			const replacement = await this._beforeWorkingDirectoryRecoveryRun?.();
			if (replacement && replacement !== this) {
				release();
				await replacement.prompt(text, options);
				return false;
			}
		}
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const shouldExpandSlashCommand = expandPromptTemplates && text.startsWith("/");
		if (shouldExpandSlashCommand && !this._isKnownSlashCommand(text)) {
			throw new Error(`Unknown slash command: ${this._slashCommandName(text)}`);
		}

		await this._promptTurn(text, options, release);
		return true;
	}

	private async _promptTurn(
		text: string,
		options: PromptOptions | undefined,
		releaseTurnStart: () => void,
	): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		const onUserMessagePrepared = options?.onUserMessagePrepared;
		let messages: AgentMessage[] | undefined;

		try {
			// Emit input event for extension interception (before skill/template expansion)
			const input = await this._runInputHandlers(
				text,
				options?.images,
				options?.source ?? "interactive",
				this.isStreaming ? options?.streamingBehavior : undefined,
			);
			if (!input) {
				options?.acceptRuntimeMailbox?.();
				preflightResult?.(true);
				return;
			}
			const { text: currentText, images: currentImages } = input;

			this._codexRestrictionRecovery.recordUserRequest(text, options?.source);

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				await this._queuePromptForStreaming(
					expandedText,
					currentImages,
					options?.streamingBehavior,
					options?.source,
					options?.acceptRuntimeMailbox,
				);
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingRunMessages();

			// Validate model
			this.validateModelAuthentication();

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			// Compaction and other preflight work can yield to a new agent run. Re-check
			// under the turn-start lock before crossing into Agent core.
			if (this.isStreaming) {
				await this._queuePromptForStreaming(
					expandedText,
					currentImages,
					options?.streamingBehavior,
					options?.source,
					options?.acceptRuntimeMailbox,
				);
				preflightResult?.(true);
				return;
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			const userMessage = {
				role: "user",
				content: userContent,
				inputSource: options?.source,
				timestamp: Date.now(),
			} satisfies AgentMessage;
			messages.push(userMessage);
			onUserMessagePrepared?.(userMessage);

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			messages.push(...(await this._applyBeforeAgentStart(expandedText, currentImages)));
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		options?.acceptRuntimeMailbox?.(messages.find((message) => message.role === "user"));
		preflightResult?.(true);
		const run = this._runAgentPrompt(messages);
		releaseTurnStart();
		try {
			await run;
		} finally {
			this._completeRuntimeMailboxSteeringTurn(this.messages);
		}
	}

	/** Try to execute an extension command. Returns true if command was found and executed. */
	private _slashCommandName(text: string): string {
		const match = text.match(/^\/([^\s]+)/);
		return `/${match?.[1] ?? ""}`;
	}

	private _isKnownSlashCommand(text: string): boolean {
		const commandName = this._slashCommandName(text).slice(1);
		if (BUILTIN_SLASH_COMMANDS.some((command) => command.name === commandName)) return true;
		if (commandName.startsWith("skill:")) {
			const skillName = commandName.slice("skill:".length);
			return this.resourceLoader.getSkills().skills.some((skill) => skill.name === skillName);
		}
		return this.promptTemplates.some((template) => template.name === commandName);
	}

	private _tryExecuteExtensionCommand(text: string, options?: PromptOptions): Promise<void> | undefined {
		const shouldExpandSlashCommand = (options?.expandPromptTemplates ?? true) && text.startsWith("/");
		if (!shouldExpandSlashCommand) return undefined;
		// The command name ends at the first whitespace character, including a newline or tab.
		const [, commandName = "", args = ""] = /^\/(\S*)\s?([\s\S]*)$/.exec(text) ?? [];
		const command = this._extensionRunner.getPromptCommand(commandName);
		if (!command) return undefined;
		return this._executeExtensionCommand(text, args, command, options);
	}

	private async _executeExtensionCommand(
		text: string,
		args: string,
		command: ResolvedCommand,
		options?: PromptOptions,
	): Promise<void> {
		if (!this.isStreaming) {
			const replacement = await this._beforeWorkingDirectoryRecoveryRun?.();
			if (replacement && replacement !== this) {
				await replacement.prompt(text, options);
				return;
			}
		}
		try {
			await command.handler(args, this._createCommandContext(command.invocationName));
		} catch (err) {
			this._extensionRunner.emitError({
				extensionPath: `command:${command.invocationName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
		}
		recordHandledSlashCommandHistory(this._controlDbPath, text);
		options?.preflightResult?.(true);
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _createCommandContext(commandName: string): ExtensionCommandContext {
		const context = this._extensionRunner.createCommandContext();
		if (this._multiAgentAgentId || (commandName !== "model" && commandName !== "effort")) return context;
		return createViewedSessionCommandContext(context, this);
	}

	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const [, skillName = "", rawArgs = ""] = /^\/skill:(\S*)([\s\S]*)$/.exec(text) ?? [];
		const args = rawArgs.trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/** Runs extension input handlers; returns undefined when a handler consumed the input. */
	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior: "steer" | "followUp" | undefined,
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		if (!this._extensionRunner.hasHandlers("input")) return { text, images };
		const result = await this._extensionRunner.emitInput(text, images, source, streamingBehavior);
		if (result.action === "handled") return undefined;
		if (result.action === "transform") return { text: result.text, images: result.images ?? images };
		return { text, images };
	}

	/** Rejects extension commands, runs input handlers, and expands skills and templates for a queued message. */
	private async _prepareQueuedInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		if (text.startsWith("/")) this._throwIfExtensionCommand(text);
		const input = await this._runInputHandlers(text, images, source, this.isStreaming ? behavior : undefined);
		if (!input) return undefined;
		const expanded = expandPromptTemplate(this._expandSkillCommand(input.text), [...this.promptTemplates]);
		return { text: expanded, images: input.images };
	}

	/**
	 * Queue a steering message while the agent is running. Interrupts active model thinking; active tool execution
	 * finishes before the message reaches the next LLM call. Runs input handlers, expands skill commands and prompt
	 * templates, and throws on extension commands.
	 */
	async steer(text: string, images?: ImageContent[], options?: { source?: InputSource }): Promise<void> {
		const source = options?.source ?? "interactive";
		const input = await this._prepareQueuedInput(text, images, "steer", source);
		if (!input) return;
		await this._withTurnStartLock(async (release) => {
			if (this.isStreaming) {
				await this._queueSteer(input.text, input.images, source);
				return;
			}

			this.validateModelAuthentication();
			await this._queueSteer(input.text, input.images, source);
			await this._prepareContinuationRun();
			const continuation = this._runAgentContinuation();
			release();
			void continuation.catch((error) => {
				console.error(`Failed to continue idle steering: ${errorMessage(error)}`);
			});
		});
	}

	/** Queue a follow-up message, delivered once the agent has no tool calls or steering left. Same input handling as steer(). */
	async followUp(text: string, images?: ImageContent[], options?: { source?: InputSource }): Promise<void> {
		const source = options?.source ?? "interactive";
		const input = await this._prepareQueuedInput(text, images, "followUp", source);
		if (input) await this._queueFollowUp(input.text, input.images, source);
	}

	/** Internal: Queue a steering message (already expanded, no extension command check). */
	private _steerAgent(message: AgentMessage): void {
		this.agent.steer(message);
		if (this._multiAgentActiveTools.size === 0) this._startThinkingPhaseDeadline();
	}

	private async _queueSteer(text: string, images?: ImageContent[], inputSource?: InputSource): Promise<void> {
		this._steeringMessages.push({ text, inputSource });
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this._steerAgent({
			role: "user",
			content,
			inputSource,
			timestamp: Date.now(),
		});
		this._emit({ type: "steering_message_queued" });
	}

	/** Internal: Queue a follow-up message (already expanded, no extension command check). */
	private async _queueFollowUp(text: string, images?: ImageContent[], inputSource?: InputSource): Promise<void> {
		this._followUpMessages.push({ text, inputSource });
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			inputSource,
			timestamp: Date.now(),
		});
	}

	private _getRuntimeMailboxControlDbPath(): string | undefined {
		return this._extensionControlDbPath ?? this.sessionManager.getMetadataControlDbPath();
	}

	private _getRuntimeMailboxAgentId(): string | null {
		return this._multiAgentAgentId ?? null;
	}

	private _getDetachedJobLifecycleController(): DetachedJobLifecycleController | undefined {
		return createAgentSessionDetachedJobLifecycleController({
			store: this._multiAgentStore,
			controlDbPath: this._getRuntimeMailboxControlDbPath(),
			processIdentity: this._detachedJobProcessIdentity,
			artifactRoot: this._agentDir,
			ownerAgentId: this._multiAgentAgentId,
			ownerSessionId: this.sessionId,
		});
	}

	async drainRuntimeCoordination(): Promise<void> {
		await this._drainRuntimeCoordinationMessages({ triggerIfIdle: true });
	}

	private async _drainRuntimeCoordinationMessages(options: {
		checkpoint?: SteeringCheckpoint;
		includeNextModelCall?: boolean;
		triggerIfIdle: boolean;
	}): Promise<boolean> {
		if (this._disableRuntimeCoordinationInbound || this._disposed) {
			return false;
		}
		this._multiAgentStore?.expireMailboxMessages(Date.now());
		try {
			this._drainTerminalOutboxProjections();
		} catch (error) {
			console.error(`Failed to drain terminal outbox projections: ${errorMessage(error)}`);
		}
		const mailboxQueued = await this._drainRuntimeMailboxMessages(options);
		const channelQueued =
			options.checkpoint === "after_tool_result" ? false : await this._drainSharedChannelMessages(options);
		return mailboxQueued || channelQueued;
	}

	private _drainTerminalOutboxProjections(): void {
		const controlDbPath = this._getRuntimeMailboxControlDbPath();
		const store = this._multiAgentStore;
		if (!controlDbPath || !store) return;
		const now = Date.now();
		const cleanupDue = isTerminalOutboxCleanupDue(this._terminalOutboxLastCleanupAt, now);
		if (cleanupDue) {
			cleanupMultiAgentTerminalOutbox(controlDbPath, terminalOutboxRetentionThreshold(now));
			this._terminalOutboxLastCleanupAt = now;
		}
		deliverTerminalOutboxProjections({
			artifactRoot: this._agentDir,
			claimId: this._terminalOutboxClaimId,
			controlDbPath,
			now: () => new Date().toISOString(),
			store,
		});
	}

	private async _drainRuntimeMailboxMessages(options: {
		checkpoint?: SteeringCheckpoint;
		includeNextModelCall?: boolean;
		triggerIfIdle: boolean;
	}): Promise<boolean> {
		const canSteerActiveTurn = this.isStreaming && options.checkpoint !== undefined;
		if (this.isStreaming) {
			if (!canSteerActiveTurn) {
				this._detachRunningToolsForPendingSteer();
				return false;
			}
		} else if (!options.triggerIfIdle) {
			return false;
		}
		if (this._runtimeMailboxDrainPromise) {
			if (canSteerActiveTurn && this._runtimeMailboxDrainMode === "prompt") return false;
			return this._runtimeMailboxDrainPromise;
		}
		const controlDbPath = this._getRuntimeMailboxControlDbPath();
		if (!controlDbPath) {
			return false;
		}
		const drainMode = canSteerActiveTurn ? "steer" : "prompt";
		let releaseMailboxDrain = () => {};
		const drain =
			drainMode === "steer"
				? this._deliverReadyRuntimeMailboxMessages(controlDbPath, options, { mode: "steer" })
				: this._withTurnStartLock((releaseTurnStart) => {
						const delivery = this.isStreaming
							? ({ mode: "steer" } as const)
							: ({ mode: "prompt", releaseMailboxDrain, releaseTurnStart } as const);
						this._runtimeMailboxDrainMode = delivery.mode;
						return this._deliverReadyRuntimeMailboxMessages(controlDbPath, options, delivery);
					});
		this._runtimeMailboxDrainMode = drainMode;
		this._runtimeMailboxDrainPromise = drain;
		releaseMailboxDrain = () => {
			if (this._runtimeMailboxDrainPromise === drain) this._runtimeMailboxDrainPromise = undefined;
		};
		try {
			return await drain;
		} finally {
			if (this._runtimeMailboxDrainPromise === drain) {
				this._runtimeMailboxDrainMode = undefined;
				this._runtimeMailboxDrainPromise = undefined;
			}
		}
	}

	/**
	 * A steer is only delivered at a tool-result or model-call checkpoint, so a long tool call would hold it back.
	 * Move detachable running tools to background jobs: their detached results reach that checkpoint at once.
	 */
	private _detachRunningToolsForPendingSteer(): void {
		if (!this._toolDetachRegistry?.hasRunning()) return;
		const controlDbPath = this._getRuntimeMailboxControlDbPath();
		if (!controlDbPath) return;
		const recipient = { agentId: this._getRuntimeMailboxAgentId(), sessionId: this.sessionId };
		const steerPending = hasPendingRuntimeMailboxMessage(
			controlDbPath,
			recipient,
			(message) => message.kind === "steer" && message.targetCheckpoint !== "when_waiting",
		);
		if (steerPending) this._toolDetachRegistry.detachAll();
	}

	private async _deliverReadyRuntimeMailboxMessages(
		controlDbPath: string,
		options: { checkpoint?: SteeringCheckpoint; includeNextModelCall?: boolean; triggerIfIdle: boolean },
		delivery: { mode: "steer" } | { mode: "prompt"; releaseMailboxDrain: () => void; releaseTurnStart: () => void },
	): Promise<boolean> {
		if (delivery.mode === "prompt" && (!this.model || !this._modelRegistry.hasConfiguredAuth(this.model))) {
			return false;
		}
		// A closed child's aborted turn ends with messages still queued; they must not start another turn.
		const lifecycle = this._multiAgentAgentId && this._multiAgentStore?.getAgent(this._multiAgentAgentId)?.lifecycle;
		if (delivery.mode === "prompt" && lifecycle === "cancelling") return false;
		const recipient = { agentId: this._getRuntimeMailboxAgentId(), sessionId: this.sessionId };
		if (readRuntimeMailboxListener(controlDbPath, recipient)?.pid !== process.pid) return false;
		const messages = takeRuntimeMailboxMessagesForDelivery(controlDbPath, recipient, (message) =>
			this._isRuntimeMailboxMessageDue(message, options),
		);
		if (options.includeNextModelCall) {
			messages.sort(
				(left, right) =>
					this._runtimeMailboxCheckpointPriority(left) - this._runtimeMailboxCheckpointPriority(right),
			);
		}
		return deliverClaimedRuntimeMailboxMessages({
			controlDbPath,
			messages,
			recipientSessionId: recipient.sessionId,
			sessionManager: this.sessionManager,
			intercept: (message) => this._interceptRuntimeMailboxMessage(message),
			onAccepted: (message) => {
				this._markStoreMailboxMessageDelivered(message);
				this._recordDetachedToolCallCompletion(message);
			},
			steer: delivery.mode === "steer" ? (message) => this._steerAgent(message) : undefined,
			prompt: async (prompt, accept) => {
				if (delivery.mode !== "prompt") throw new Error("Mailbox prompt delivery requires the turn-start lock");
				delivery.releaseMailboxDrain();
				await this._promptTurn(
					prompt,
					{ expandPromptTemplates: false, source: "extension", acceptRuntimeMailbox: accept },
					delivery.releaseTurnStart,
				);
				this._completeRuntimeMailboxSteeringTurn(this.messages);
			},
		});
	}

	private _isRuntimeMailboxMessageDue(
		message: RuntimeMailboxMessage,
		options: { checkpoint?: SteeringCheckpoint; includeNextModelCall?: boolean; triggerIfIdle: boolean },
	): boolean {
		if (message.kind !== "steer") {
			return options.checkpoint !== "after_tool_result" || options.includeNextModelCall === true;
		}
		const checkpoint = message.targetCheckpoint ?? "next_model_call";
		if (checkpoint === "after_tool_result") return options.checkpoint === "after_tool_result";
		if (checkpoint === "when_waiting") return options.triggerIfIdle && !this.isStreaming;
		return options.checkpoint === "next_model_call" || options.includeNextModelCall === true || options.triggerIfIdle;
	}

	private _runtimeMailboxCheckpointPriority(message: RuntimeMailboxMessage): number {
		return message.targetCheckpoint === "after_tool_result" ? 0 : 1;
	}

	/**
	 * Records a durable transcript entry when a detached tool call's job agent
	 * reaches a terminal state, correlating the outcome back to the originating
	 * toolCallId (the immutable tool_result only ever says "detached").
	 */
	private _recordDetachedToolCallCompletion(message: RuntimeMailboxMessage): void {
		recordDetachedToolCallCompletion({ message, store: this._multiAgentStore, sessionManager: this.sessionManager });
	}

	private async _interceptRuntimeMailboxMessage(message: RuntimeMailboxMessage): Promise<boolean> {
		if (!this._extensionRunner.hasHandlers("runtime_mailbox")) return false;
		const result = await this._extensionRunner.emitRuntimeMailbox({ type: "runtime_mailbox", message });
		return result.handled === true;
	}

	private async _drainSharedChannelMessages(options: { triggerIfIdle: boolean }): Promise<boolean> {
		if (this._disableRuntimeCoordinationInbound || this._getRuntimeMailboxAgentId() !== null) {
			return false;
		}
		if (this._sharedChannelDrainInProgress) {
			// The running drain may have read the channel before this wake's message arrived; make it re-read.
			this._sharedChannelDrainRequested = true;
			return false;
		}
		const controlDbPath = this._getRuntimeMailboxControlDbPath();
		if (!controlDbPath) {
			return false;
		}
		this._sharedChannelDrainInProgress = true;
		try {
			let queued = false;
			do {
				this._sharedChannelDrainRequested = false;
				if (options.triggerIfIdle && this.isStreaming) break;
				queued = (await this._drainSharedChannelMessagesFromDb(controlDbPath, options)) || queued;
			} while (this._sharedChannelDrainRequested);
			return queued;
		} finally {
			this._sharedChannelDrainInProgress = false;
		}
	}

	private async _drainSharedChannelMessagesFromDb(
		controlDbPath: string,
		options: { triggerIfIdle: boolean },
	): Promise<boolean> {
		const recipient = this._sharedChannelRecipient();
		const cursor = initializeSharedChannelCursorAtTail(controlDbPath, recipient);
		const messageSnapshot = readSharedChannelMessageSnapshot(controlDbPath, cursor);
		if (!messageSnapshot) return false;
		const { lastMessageId, messages } = messageSnapshot;
		const deliverableMessages = messages.filter(
			(message) => !isOwnSharedChannelMessage(message, recipient) && !isSubagentSharedChannelMessage(message),
		);
		if (deliverableMessages.length === 0) {
			advanceSharedChannelCursor(controlDbPath, recipient, lastMessageId);
			return false;
		}

		try {
			const prompt = formatSharedChannelPrompt(deliverableMessages, recipient.sessionId);
			// Acceptance advances the cursor (monotonic): an idle delivery resolves only after its whole turn.
			const accept = () => advanceSharedChannelCursor(controlDbPath, recipient, lastMessageId);
			const queued = await this._sendSharedChannelPrompt(prompt, options, accept);
			accept();
			this._onSharedChannelMessageDelivered?.(prompt);
			return queued;
		} catch (error) {
			if (isSessionBusyPromptError(error)) return false;
			throw error;
		}
	}

	private _sharedChannelRecipient(): RuntimeMailboxAddress {
		return {
			agentId: this._getRuntimeMailboxAgentId(),
			sessionId: this.sessionId,
		};
	}

	private async _sendSharedChannelPrompt(prompt: string, options: { triggerIfIdle: boolean }, onAccepted: () => void) {
		const message = {
			customType: "shared_channel",
			content: prompt,
			display: true,
		};
		if (options.triggerIfIdle && !this.isStreaming) {
			await this.sendCustomMessage(message, { triggerTurn: true, deliverAs: "followUp", onAccepted });
			return false;
		}
		this._followUpMessages.push({ text: prompt, customType: message.customType });
		this._emitQueueUpdate();
		this.agent.followUp({ role: "custom", ...message, timestamp: Date.now() });
		return true;
	}

	// Durable acceptance precedes canonical deletion and projection refresh.
	private _markStoreMailboxMessageDelivered(message: RuntimeMailboxMessage): string | undefined {
		const storeRef = message.storeRef;
		if (!storeRef) {
			return undefined;
		}
		if (this._multiAgentStore?.getPersistenceTarget()?.sessionPath === storeRef.sessionPath) {
			if (message.kind === "steer") {
				return this._markStoreSteeringDelivered(message);
			}
			this._multiAgentStore.expireMailboxMessages(Date.now());
			return undefined;
		}
		return undefined;
	}

	private _markStoreSteeringDelivered(message: RuntimeMailboxMessage): string | undefined {
		const agentId = message.recipient.agentId;
		if (!agentId || !this._multiAgentStore) {
			return undefined;
		}
		const persistence = this._multiAgentStore.getPersistenceTarget();
		if (!persistence) return undefined;
		const agent = readMultiAgentAgent(persistence.controlDbPath, persistence.sessionPath, agentId);
		if (!agent) return undefined;
		this._multiAgentStore.expireMailboxMessages(Date.now());
		this._multiAgentStore.publishLifecycleCoordinatorSnapshot(agent as unknown as AgentSnapshot);
		this._runtimeMailboxSteeringAgentIds.add(agentId);
		return agentId;
	}

	private _startRuntimeMailboxPolling(): void {
		if (this._disableRuntimeCoordinationInbound) return;
		const controlDbPath = this._getRuntimeMailboxControlDbPath();
		if (!controlDbPath) return;
		if (this._runtimeMailboxPollTimer && this._runtimeMailboxControlDbPath === controlDbPath) return;
		this._stopRuntimeMailboxPolling();
		this._terminalOutboxLastCleanupAt = undefined;
		this._runtimeMailboxControlDbPath = controlDbPath;
		this._runtimeMailboxControlDbRelease = retainControlDbConnection(controlDbPath);
		this._runtimeMailboxPollTimer = setInterval(() => {
			void this._drainRuntimeCoordinationMessages({ triggerIfIdle: true }).catch((error: unknown) => {
				console.error("Failed to drain runtime coordination messages:", error);
			});
		}, RUNTIME_MAILBOX_POLL_INTERVAL_MS);
	}

	private _stopRuntimeMailboxPolling(): void {
		if (this._runtimeMailboxPollTimer) {
			clearInterval(this._runtimeMailboxPollTimer);
			this._runtimeMailboxPollTimer = undefined;
		}
		this._runtimeMailboxControlDbRelease?.();
		this._runtimeMailboxControlDbRelease = undefined;
		this._runtimeMailboxControlDbPath = undefined;
	}

	private _startRuntimeMailboxSignalWake(): void {
		if (this._disableRuntimeCoordinationInbound) return;
		const controlDbPath = this._getRuntimeMailboxControlDbPath();
		if (!controlDbPath) {
			return;
		}
		installRuntimeMailboxSignalKeepalive();
		const agentId = this._getRuntimeMailboxAgentId();
		this._registerRuntimeMailboxListeners(controlDbPath, agentId);
		const recipient = { agentId, sessionId: this.sessionId };
		initializeSharedChannelCursorAtTail(controlDbPath, recipient);
		this._startRuntimeMailboxHeartbeat();
		if (process.platform === "win32" || this._runtimeMailboxSignalHandler) {
			return;
		}
		this._runtimeMailboxSignalHandler = () => {
			void this._drainRuntimeCoordinationMessages({ triggerIfIdle: true }).catch((error: unknown) => {
				console.error("Failed to drain runtime coordination messages:", error);
			});
		};
		process.on("SIGUSR2", this._runtimeMailboxSignalHandler);
	}

	private _registerRuntimeMailboxListeners(controlDbPath: string, agentId: string | null): void {
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId, sessionId: this.sessionId },
			process.pid,
			this.sessionFile,
			{
				isMailboxStoreRefAccepted: (ref) => isMailboxStoreRefAccepted(this.sessionManager.getEntries(), ref),
			},
		);
	}

	private _startRuntimeMailboxHeartbeat(): void {
		if (this._runtimeMailboxHeartbeatTimer) return;
		const agentId = this._getRuntimeMailboxAgentId();
		this._runtimeMailboxHeartbeatTimer = setInterval(() => {
			const controlDbPath = this._getRuntimeMailboxControlDbPath();
			if (!controlDbPath) return;
			try {
				this._registerRuntimeMailboxListeners(controlDbPath, agentId);
			} catch (error) {
				console.error("Failed to refresh runtime mailbox listeners:", error);
			}
		}, RUNTIME_MAILBOX_HEARTBEAT_INTERVAL_MS);
	}

	private _stopRuntimeMailboxHeartbeat(): void {
		if (!this._runtimeMailboxHeartbeatTimer) return;
		clearInterval(this._runtimeMailboxHeartbeatTimer);
		this._runtimeMailboxHeartbeatTimer = undefined;
	}

	private _stopRuntimeMailboxSignalWake(): void {
		this._stopRuntimeMailboxHeartbeat();
		this._retireRuntimeMailboxListeners();
		if (!this._runtimeMailboxSignalHandler || process.platform === "win32") {
			this._runtimeMailboxSignalHandler = undefined;
			return;
		}
		process.off("SIGUSR2", this._runtimeMailboxSignalHandler);
		this._runtimeMailboxSignalHandler = undefined;
	}

	private _retireRuntimeMailboxListeners(): void {
		if (this.noSupervisor) return;
		const controlDbPath = this._getRuntimeMailboxControlDbPath();
		if (!controlDbPath) return;
		const agentId = this._getRuntimeMailboxAgentId();
		retireRuntimeMailboxListener(controlDbPath, { agentId, sessionId: this.sessionId }, process.pid);
	}

	/** Throw an error if the text is an extension command. */
	private _throwIfExtensionCommand(text: string): void {
		const commandName = this._slashCommandName(text).slice(1);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 * Streaming: steered or queued as follow-up; with triggerTurn false, appended once the current turn ends.
	 * Not streaming: appended to state/session, and starts a turn when triggerTurn is set.
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; onAccepted?: () => void },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this._steerAgent(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._withTurnStartLock(async (release) => {
				if (this.isStreaming) {
					if (options.deliverAs === "followUp") {
						this.agent.followUp(appMessage);
					} else {
						this._steerAgent(appMessage);
					}
					return;
				}

				const startMessages = await this._applyBeforeAgentStart("");
				if (this.isStreaming)
					throw new Error("Agent is already processing. Wait for completion before continuing.");
				const run = this._runAgentPrompt([appMessage, ...startMessages]);
				options.onAccepted?.();
				release();
				await run;
			});
		} else if (this.isStreaming) {
			// Appending now could land between an assistant tool call and its result; providers reject that order.
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		this.agent.state.messages.push(appMessage);
		const { customType, content, display, details } = appMessage;
		this.sessionManager.appendCustomMessageEntry(customType, content, display, details);
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	private _flushPendingCustomMessages(): void {
		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const appMessage of pending) this._appendCustomMessage(appMessage);
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this.getSteeringMessages()];
		const followUp = [...this.getFollowUpMessages()];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	hasPendingMessages(): boolean {
		return this.pendingMessageCount > 0 || this._externalUserInputReservations > 0;
	}

	reserveExternalUserInput(): () => void {
		this._codexRestrictionRecovery.cancelPendingValidation();
		let released = false;
		this._externalUserInputReservations++;
		return () => {
			if (released) return;
			released = true;
			this._externalUserInputReservations = Math.max(0, this._externalUserInputReservations - 1);
		};
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages.map((message) => message.text);
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages.map((message) => message.text);
	}

	/** Snapshot queue display data with existing input provenance, without consuming delivery queues. */
	getQueuedMessagePreviews(): {
		steering: readonly QueuedMessagePreview[];
		followUp: readonly QueuedMessagePreview[];
	} {
		return {
			steering: this._steeringMessages.map((message) => ({ ...message })),
			followUp: this._followUpMessages.map((message) => ({ ...message })),
		};
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort the current operation, then submit preserved user input. A background
	 * turn may start after abort becomes idle, so the replacement prompt queues as
	 * steering instead of failing or losing the user's text.
	 */
	async interrupt(message = "", source: InputSource = "interactive"): Promise<void> {
		await interruptSession(this, message, source);
	}

	/** Abort current operation and wait for agent to become idle. */
	async abort(): Promise<void> {
		this._codexRestrictionRecovery.cancelPendingValidation();
		if (this._thinkingTimeoutDispatch) this._thinkingTimeoutDispatch.cancelled = true;
		this.abortRetry();
		this._clearThinkingPhaseDeadline();
		this._thinkingPhaseTimeoutError = undefined;
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		this.agent.abort();
		await this.agent.waitForIdle();
	}

	registerSupervisorReviewCancellation(handler: () => void): () => void {
		this._supervisorReviewCancellationHandler = handler;
		return () => {
			if (this._supervisorReviewCancellationHandler === handler) {
				this._supervisorReviewCancellationHandler = undefined;
			}
		};
	}

	cancelSupervisorReview(): boolean {
		const handler = this._supervisorReviewCancellationHandler;
		if (!handler) return false;
		this._supervisorReviewCancellationHandler = undefined;
		handler();
		return true;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<Api>,
		previousModel: Model<Api> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured and saves to the session.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(
		model: Model<Api>,
		source: "set" | "cycle" = "set",
		thinkingLevel = this._getThinkingLevelForModelSwitch(),
	): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this._publishChildAgentModel(model, clampThinkingLevel(model, thinkingLevel) as ThinkingLevel);
		this._clearCompactionFailure();
		const previousModel = this.model;
		this.agent.state.model = model;
		this.sessionManager.setSessionModel(model.provider, model.id);
		if (this._multiAgentAgentId === undefined) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		}

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, source);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models from --models, /models, or enabledModels settings. Does not cycle all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if no narrow scope is configured
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		const scopedModels = await this._getScopedModelsForCycle();
		if (scopedModels.length > 0) {
			return this._cycleScopedModel(direction, scopedModels);
		}
		return undefined;
	}

	private async _getScopedModelsForCycle(): Promise<ScopedModel[]> {
		if (this._scopedModels.length > 0) {
			return [...this._scopedModels];
		}

		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels || enabledModels.length === 0) {
			return [];
		}

		return this._filterNarrowModelScope(await resolveModelScope(enabledModels, this._modelRegistry));
	}

	private async _filterNarrowModelScope(models: ReadonlyArray<ScopedModel>): Promise<ScopedModel[]> {
		const availableModels = await this._modelRegistry.getAvailable();
		const scopeCoversEveryAvailableModel = availableModels.every((model) =>
			models.some((scoped) => modelsAreEqual(scoped.model, model)),
		);
		if (scopeCoversEveryAvailableModel) {
			return [];
		}
		return [...models];
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		models: ReadonlyArray<ScopedModel>,
	): Promise<ModelCycleResult | undefined> {
		const scopedModels = models.filter((scoped) => this._modelRegistry.hasConfiguredAuth(scoped.model));
		const len = scopedModels.length;
		const currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, this.model));
		// An active model outside the scope cycles onto it: forward to the first entry, backward to the last.
		if (len === 0 || (len === 1 && currentIndex === 0)) return undefined;
		const step = direction === "forward" ? 1 : len - 1;
		const nextIndex = currentIndex === -1 ? (direction === "forward" ? 0 : len - 1) : (currentIndex + step) % len;
		const next = scopedModels[nextIndex];
		if (next === undefined) throw new Error("scoped model missing while cycling models");
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		await this.setModel(next.model, "cycle", thinkingLevel);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this._publishChildAgentModel(this.model, effectiveLevel);
		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.setSessionThinkingLevel(effectiveLevel);
			if (this._multiAgentAgentId === undefined && (this.supportsThinking() || effectiveLevel !== "off")) {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (nextLevel === undefined) throw new Error("thinking level missing while cycling levels");

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/** Check if current model supports thinking/reasoning. */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/** Set steering message mode. Saves to settings. */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/** Set follow-up message mode. Saves to settings. */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this._withTurnStartLock((release) => this._compact(customInstructions, release));
	}

	private async _compact(
		customInstructions: string | undefined,
		releaseTurnStart: () => void,
	): Promise<CompactionResult> {
		const wasRunningAgentTurn = this.isStreaming;
		this._disconnectFromAgent();
		await this.abort();
		await this._backgroundCompaction.cancel();
		const compactionAbortController = new AbortController();
		this._compactionAbortController = compactionAbortController;
		const sourceHint = await this.getCompactionSourceHint("manual", false);
		this._emit({ type: "compaction_start", reason: "manual", sourceHint });
		const startedAt = Date.now();
		let saved: { result: CompactionResult; willRetry: boolean };

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();
			const auth = settings.enabled ? await this._getCompactionRequestAuth(this.model) : {};
			const { apiKey, headers, env } = auth;

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const preflight = await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: compactionAbortController.signal,
				});
				if (preflight?.cancel) {
					compactionAbortController.abort();
					throw new Error("Compaction cancelled");
				}
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("compaction")) {
				const result = await this._extensionRunner.emit({
					type: "compaction",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: compactionAbortController.signal,
				});

				if (result?.cancel) {
					compactionAbortController.abort();
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;
			let compactedResultTokens: number | undefined;
			let compactedResultBytes: number | undefined;
			let source: CompactionResult["source"];
			let providerNative: CompactionResult["providerNative"];

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
				compactedResultTokens = extensionCompaction.compactedResultTokens;
				compactedResultBytes = extensionCompaction.compactedResultBytes;
				source = extensionCompaction.source;
				providerNative = extensionCompaction.providerNative;
			} else if (!settings.enabled) {
				throw new Error(BUILT_IN_COMPACTION_DISABLED_MESSAGE);
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					customInstructions,
					compactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFn,
					env,
					this.sessionManager.getSessionId(),
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				details = result.details;
				compactedResultTokens = result.compactedResultTokens;
				compactedResultBytes = result.compactedResultBytes;
				source = result.source;
				providerNative = result.providerNative;
			}

			if (compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			const durationMs = Date.now() - startedAt;
			this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				durationMs,
				providerNative,
			);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const tokenEstimate = estimateCompactedContextTokens({
				messages: sessionContext.messages,
				summary,
				tokensBefore,
				durationMs,
				compactedResultTokens,
			});
			const willRetry = wasRunningAgentTurn || this._shouldContinueAfterManualCompaction(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				durationMs,
				estimatedTokensAfter: tokenEstimate.estimatedTokensAfter,
				keptFromPreviousContextTokens: tokenEstimate.keptFromPreviousContextTokens,
				compactedResultTokens,
				compactedResultBytes,
				source,
				providerNative,
				details,
			};
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry,
			});
			this._clearCompactionFailure();
			saved = { result: compactionResult, willRetry };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// The signal, not the error text, tells a cancellation from a failure (upstream #9777).
			const aborted = compactionAbortController.signal.aborted;
			if (!aborted) {
				this._recordCompactionFailure(message);
			}
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			if (this._compactionAbortController === compactionAbortController) {
				this._compactionAbortController = undefined;
			}
			this._reconnectToAgent();
		}
		// The compaction is saved; errors from the resumed turn are turn errors, not compaction failures.
		if (saved.willRetry) {
			await this._continueAfterManualCompaction(wasRunningAgentTurn, releaseTurnStart);
		}
		return saved.result;
	}

	/** Cancel in-progress compaction (manual or auto). */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
		this._backgroundCompaction.abort();
	}

	private _hasReadyBackgroundCompaction(): boolean {
		return this._backgroundCompaction.hasReady();
	}

	/** Arm one timer that compacts the idle session shortly before its provider prompt cache expires. */
	private _scheduleIdleCompaction(): void {
		this._backgroundCompaction.scheduleIdle();
	}

	/** Cancel in-progress compaction-summary materialization. */
	abortCompactionSummaryMaterialization(): void {
		abortCompactionSummaryMaterialization(this._compactionSummaryMaterializationAbortController);
	}

	/** Cancel in-progress branch summarization. */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end, before prompt submission, and between provider requests.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact. Auto-resumes once when the turn was
	 *    "length"-truncated (unfinished work); otherwise NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param postRunCheck True when called after agent_end; false before a prompt or next provider request.
	 *   Checks inside an active run never start another continuation. Default: true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, postRunCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();

		// Skip if message was aborted (user cancelled) - unless this is the pre-prompt check
		if (postRunCheck && assistantMessage.stopReason === "aborted") return false;

		const model = this.model;
		const contextWindow = model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel = !!model && this._modelRegistry.isMessageFromModel(assistantMessage, model);

		// Skip compaction checks if this assistant message precedes the latest
		// compaction boundary. Persisted branch order disambiguates messages that
		// share the boundary timestamp; synthetic checks fall back to timestamps.
		const branchEntries = this.sessionManager.getBranch();
		const compactionEntry = getLatestCompactionEntry(branchEntries);
		if (assistantMessagePrecedesCompaction(branchEntries, assistantMessage, compactionEntry)) return false;

		// Case 1: Overflow - LLM returned context overflow error, or reported usage exceeded
		// the configured window. A successful response over the configured window should compact
		// but must not retry: the assistant answer already completed and agent.continue() cannot
		// continue from an assistant message.
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			const shouldRetryAfterCompaction = assistantMessage.stopReason !== "stop";
			const shouldContinueAfterCompaction = postRunCheck && shouldRetryAfterCompaction;

			if (!shouldRetryAfterCompaction) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			if (postRunCheck) {
				this._overflowRecoveryAttempted = true;
				// Remove the error message from agent state (it IS saved to session for history,
				// but we don't want it in context for the retry)
				const messages = this.agent.state.messages;
				if (messages.length > 0 && messages.at(-1)?.role === "assistant") {
					this.agent.state.messages = messages.slice(0, -1);
				}
			}
			return await this._runAutoCompaction("overflow", true, shouldContinueAfterCompaction);
		}

		// Case 2: Threshold - context is getting large
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			// Without provider usage, estimate.tokens is the pure message-size estimate (#8328). Usage from kept
			// pre-compaction messages reflects the old (larger) context, so estimate the rebuilt context from content.
			const usageMsg = estimate.lastUsageIndex === null ? undefined : messages[estimate.lastUsageIndex];
			const usageIsStale =
				compactionEntry &&
				usageMsg?.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime();
			contextTokens = usageIsStale
				? messages.reduce((tokens, message) => tokens + estimateTokens(message), 0)
				: estimate.tokens;
		} else {
			contextTokens = estimateThresholdContextTokens(
				this.agent.state.messages,
				assistantMessage,
				directContextTokens,
				settings.thresholdTokens,
			);
		}
		if (shouldCompact(contextTokens, contextWindow, { ...settings, enabled: true }, model?.autoCompactionThreshold)) {
			// A "length"-stopped turn was truncated mid-work: compact and resume it once.
			// Pre-prompt checks must not resume - the incoming user prompt supersedes the
			// truncated turn.
			const turnWasTruncated = assistantMessage.stopReason === "length";
			const willRetry = postRunCheck && turnWasTruncated && !this._lengthRecoveryAttempted;
			if (willRetry) {
				this._lengthRecoveryAttempted = true;
			}
			return await this._runAutoCompaction("threshold", willRetry);
		}
		if (this._hasReadyBackgroundCompaction()) {
			return await this._runAutoCompaction("threshold", false);
		}
		this._backgroundCompaction.start(contextTokens, contextWindow);
		return false;
	}

	/** Internal: Run auto-compaction with events. */
	private _recordCompactionFailure(message: string): void {
		const cooldownMs = compactionRetryCooldownMs(message);
		if (cooldownMs === undefined) return;
		this._compactionFailureCount++;
		this._compactionCooldownUntil =
			this._compactionFailureCount >= MAX_CONSECUTIVE_COMPACTION_FAILURES
				? Number.POSITIVE_INFINITY
				: Date.now() + cooldownMs;
	}

	private _clearCompactionFailure(): void {
		this._compactionFailureCount = 0;
		this._compactionCooldownUntil = 0;
	}

	private async _runAutoCompaction(
		reason: "overflow" | "threshold" | "idle",
		willRetry: boolean,
		continueAfterCompaction = willRetry,
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (Date.now() < this._compactionCooldownUntil) {
			return false;
		}
		let started = false;
		let autoCompactionAbortController: AbortController | undefined;

		try {
			if (!this.model) {
				return false;
			}

			const cachedCompaction = await this._backgroundCompaction.take();
			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			let env: Record<string, string> | undefined;
			if (!cachedCompaction && settings.enabled) {
				if (this.agent.streamFn === streamSimple) {
					const authResult = await this._modelRegistry.getApiKeyAndHeaders(this.model);
					if (!authResult.ok || !authResult.apiKey) {
						return false;
					}
					apiKey = authResult.apiKey;
					headers = authResult.headers;
					env = authResult.env;
				} else {
					({ apiKey, headers, env } = await this._getCompactionRequestAuth(this.model));
				}
			}

			const pathEntries = cachedCompaction?.branchEntries ?? this.sessionManager.getBranch();

			const preparation = cachedCompaction?.preparation ?? prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			const sourceHint = await this.getCompactionSourceHint(reason, willRetry);
			// Install the controller first, so a compaction_start listener can abort (upstream #9777).
			autoCompactionAbortController = new AbortController();
			this._autoCompactionAbortController = autoCompactionAbortController;
			this._emit({ type: "compaction_start", reason, sourceHint });
			started = true;
			autoCompactionAbortController.signal.throwIfAborted();
			const startedAt = Date.now();

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const preflight = await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: autoCompactionAbortController.signal,
				});
				if (preflight?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}
			}

			let extensionCompaction = cachedCompaction?.compaction;
			let fromExtension = cachedCompaction?.fromExtension ?? false;

			if (!cachedCompaction && this._extensionRunner.hasHandlers("compaction")) {
				const extensionResult = await this._extensionRunner.emit({
					type: "compaction",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: autoCompactionAbortController.signal,
				});

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;
			let compactedResultTokens: number | undefined;
			let compactedResultBytes: number | undefined;
			let source: CompactionResult["source"];
			let providerNative: CompactionResult["providerNative"];

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				details = extensionCompaction.details;
				compactedResultTokens = extensionCompaction.compactedResultTokens;
				compactedResultBytes = extensionCompaction.compactedResultBytes;
				source = extensionCompaction.source;
				providerNative = extensionCompaction.providerNative;
			} else if (!settings.enabled) {
				throw new Error(BUILT_IN_COMPACTION_DISABLED_MESSAGE);
			} else {
				// Generate compaction result
				const compactResult = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					undefined,
					autoCompactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFn,
					env,
					this.sessionManager.getSessionId(),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
				compactedResultTokens = compactResult.compactedResultTokens;
				compactedResultBytes = compactResult.compactedResultBytes;
				source = compactResult.source;
			}

			if (autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			const durationMs = cachedCompaction?.generationDurationMs ?? Date.now() - startedAt;
			this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				durationMs,
				providerNative,
			);
			this._clearCompactionFailure();
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const tokenEstimate = estimateCompactedContextTokens({
				messages: sessionContext.messages,
				summary,
				tokensBefore,
				durationMs,
				compactedResultTokens,
			});

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				durationMs,
				estimatedTokensAfter: tokenEstimate.estimatedTokensAfter,
				keptFromPreviousContextTokens: tokenEstimate.keptFromPreviousContextTokens,
				compactedResultTokens,
				compactedResultBytes,
				source,
				providerNative,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (continueAfterCompaction) {
				// Drop the failed/truncated assistant message from agent state (it stays in
				// session history) so agent.continue() can resume from the preceding message.
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant") {
					const stopReason = (lastMsg as AssistantMessage).stopReason;
					if (stopReason === "error" || stopReason === "length") {
						this.agent.state.messages = messages.slice(0, -1);
					}
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			// A cancelled compaction is not a failure, whatever error the cancelled request ended with.
			const aborted = autoCompactionAbortController?.signal.aborted === true;
			if (!aborted) this._recordCompactionFailure(errorMessage);
			if (started) {
				const failurePrefix = reason === "overflow" ? "Context overflow recovery failed" : "Auto-compaction failed";
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage: aborted ? undefined : `${failurePrefix}: ${errorMessage}`,
				});
			}
			return false;
		} finally {
			if (this._autoCompactionAbortController === autoCompactionAbortController) {
				this._autoCompactionAbortController = undefined;
			}
		}
	}

	/** Toggle auto-compaction setting. */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.footerData !== undefined) {
			this._extensionFooterData = bindings.footerData;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.controlDbPath !== undefined) {
			this._extensionControlDbPath = bindings.controlDbPath;
		}
		this._startRuntimeMailboxSignalWake();
		this._startRuntimeMailboxPolling();
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._extensionsBound = true;
		this._applyExtensionBindings(this._extensionRunner);
		await waitForHeadlessSessionStartRelease();
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
		this._scheduleIdleCompaction();
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		if (this._extensionCommandContextActions !== undefined) {
			runner.bindCommandContext(this._extensionCommandContextActions);
		}

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _restartFromExtension(options?: { notice?: string; process?: boolean }): Promise<void> {
		if (this._multiAgentRuntimeRole === "child") {
			throw new Error("Child agent runtimes cannot restart Pi");
		}
		if (!this._extensionCommandContextActions) {
			throw new Error("Restart is not available in this session mode");
		}
		return this._extensionCommandContextActions.restart(options);
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		const callCommand = async (name: string, args?: string): Promise<unknown> => {
			const command = runner.getPromptCommand(name);
			if (!command) throw new Error(`Command not found: ${name}`);
			return command.handler(args ?? "", this._createCommandContext(name));
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				requestResumeContinuation: () => this.requestResumeContinuation(),
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				callTool: (toolName, params, signal, toolCallId) =>
					this._callActiveTool(toolName, params, signal, toolCallId),
				callCommand,
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getNoSupervisor: () => this.noSupervisor,
				getModel: () => this.model,
				getThinkingLevel: () => this.thinkingLevel,
				getScopedModels: () => this.scopedModels,
				getFooterData: () => this._extensionFooterData,
				isIdle: () => !this.isStreaming,
				hasActiveRetry: () => this.hasActiveRetry,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				registerSupervisorReviewCancellation: (handler) => this.registerSupervisorReviewCancellation(handler),
				hasPendingMessages: () => this.hasPendingMessages(),
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				restart: (options) => this._restartFromExtension(options),
				getControlDbPath: () => this._getRuntimeMailboxControlDbPath(),
				getContextUsage: () => this.getContextUsage(),
				getMultiAgentAgentId: () => this._multiAgentAgentId,
				getMultiAgentParentSessionId: () => this._multiAgentParentSessionId,
				getMultiAgentRequiresAgentId: () => this._multiAgentRequiresAgentId,
				getDetachedJobLifecycle: () => this._getDetachedJobLifecycleController(),
				getMultiAgentStore: () => this._multiAgentStore,
				getToolDetachRegistry: () => this._toolDetachRegistry,
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		const isAllowedTool = (name: string): boolean =>
			isAllowedSessionTool(name, allowedToolNames, excludedToolNames, this.noSupervisor);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		nextActiveToolNames.push("end_turn");
		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? {
					...Object.fromEntries(
						Object.entries(this._baseToolsOverride).map(([name, tool]) => [
							name,
							createToolDefinitionFromAgentTool(tool),
						]),
					),
					end_turn: createEndTurnToolDefinition(),
				}
			: createToolDefinitionsForAvailableExecutables(this._cwd, {
					read: { autoResizeImages },
					bash: {
						backgroundJobs: this._multiAgentStore
							? { getLifecycle: () => this._getDetachedJobLifecycleController(), store: this._multiAgentStore }
							: undefined,
						commandPrefix: shellCommandPrefix,
						detachRegistry: this._toolDetachRegistry,
						shellPath,
					},
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
			this.settingsManager,
			createInternalCommands(),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: DEFAULT_ACTIVE_TOOL_NAMES;
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, { type: "session_shutdown", reason: "reload" });
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		if (this._extensionsBound) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		// Retrying sooner than the provider requested repeats the same failure.
		if (this._retryDelayExceedsCap(message)) return false;
		return isRetryableAssistantError(message);
	}

	/** Whether the provider asked to wait longer than the configured retry delay cap. */
	private _retryDelayExceedsCap(message: AssistantMessage): boolean {
		if (message.retryAfterMs === undefined) return false;
		const { maxRetryDelayMs } = this.settingsManager.getProviderRetrySettings();
		return maxRetryDelayMs > 0 && message.retryAfterMs > maxRetryDelayMs;
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff and jitter.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = calculateRetryDelayMs(
			this._retryAttempt,
			settings.baseDelayMs,
			settings.maxBackoffMs,
			Math.random(),
		);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages.at(-1)?.role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with the reported backoff delay (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/** Cancel in-progress retry. */
	abortRetry(): void {
		this._retryAbortController?.abort();
		const dispatch = this._thinkingTimeoutDispatch;
		if (!dispatch?.recoveryUsed) return;
		dispatch.cancelled = true;
		this._clearThinkingPhaseDeadline();
		this._thinkingPhaseTimeoutError = undefined;
		this.agent.abort();
	}

	/** Surface a provider-internal retry or transport fallback as a session event. */
	notifyProviderRetry(retry: ProviderRetryEvent): void {
		this._emit({ type: "provider_stream_retry", retry });
	}

	/** Whether an automatic retry attempt has started and has not yet settled. */
	get hasActiveRetry(): boolean {
		const dispatch = this._thinkingTimeoutDispatch;
		return this._retryAttempt > 0 || (dispatch?.recoveryUsed === true && !dispatch.cancelled);
	}

	/** From a turn's start to its agent_settled event: the agent is idle while a retry or compaction is pending. */
	get isDispatching(): boolean {
		return this._thinkingTimeoutDispatch !== undefined;
	}

	/** Whether auto-retry backoff sleep is currently in progress. */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/** Toggle auto-retry setting. */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
			this._emit({ type: "bash_messages_committed", messages: [bashMessage] });
		}
	}

	/** Cancel running bash command. */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) abortController.abort();
	}

	detachRunningTool(): boolean {
		return this._toolDetachRegistry?.detachRunning() ?? false;
	}

	detachAllRunningTools(): void {
		this._toolDetachRegistry?.detachAll();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	get hasDetachableTool(): boolean {
		return this._toolDetachRegistry?.hasRunning() ?? false;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/** Appends custom and bash messages held back while the agent ran. */
	private _flushPendingRunMessages(): void {
		this._flushPendingCustomMessages();
		this._flushPendingBashMessages();
	}

	/** Flush pending bash messages to agent state and session after the run, keeping message order. */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		const messages = this._pendingBashMessages;
		for (const bashMessage of messages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
		this._emit({ type: "bash_messages_committed", messages });
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/** Set a display name for the current session. */
	setSessionName(name: string): void {
		this.sessionManager.setSessionName(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	clearSessionName(): void {
		this.sessionManager.setSessionName(undefined);
		const event = { type: "session_info_changed", name: undefined } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	updateCompactionSummary(entryId: string, summary: string): void {
		updateCompactionSummary(this.sessionManager, this.agent, entryId, summary, this._backgroundCompaction);
	}

	async materializeCompactionSummary(entryId: string): Promise<MaterializeCompactionSummaryResult> {
		return materializeCompactionSummary({
			entryId,
			sessionManager: this.sessionManager,
			model: this.model,
			settingsManager: this.settingsManager,
			agent: this.agent,
			getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
			abortController: this._compactionSummaryMaterializationAbortController,
			setAbortController: (controller) => {
				this._compactionSummaryMaterializationAbortController = controller;
			},
		});
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree, in the same session file (unlike fork()).
	 * `summarize` summarizes the abandoned branch; `customInstructions`/`replaceInstructions` adjust the summarizer
	 * prompt; `label` labels the branch summary entry. Returns editorText when the target is a user message.
	 * Rejects while a response streams or compaction or another navigation runs: their output would land on the new
	 * branch. Holds the turn-start lock until the new leaf is installed, so a prompt sent meanwhile runs on it.
	 */
	async navigateTree(targetId: string, options: NavigateTreeOptions = {}): Promise<NavigateTreeResult> {
		if (this.isCompacting) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}
		return this._withTurnStartLock((release) => this._navigateTree(targetId, options, release));
	}

	private async _navigateTree(
		targetId: string,
		options: NavigateTreeOptions,
		releaseTurnStart: () => void,
	): Promise<NavigateTreeResult> {
		// Checked under the lock: a prompt that held it during preflight is streaming once it is released.
		if (this.isStreaming)
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		const oldLeafId = this.sessionManager.getLeafId();
		if (targetId === oldLeafId) return { cancelled: false };

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		const branchSummaryAbortController = new AbortController();
		this._branchSummaryAbortController = branchSummaryAbortController;

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model;
				if (!model) {
					throw new Error("No model available for summarization");
				}
				const { apiKey, headers, env } = await this._getRequiredRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					env,
					signal: branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFn,
					sessionId: this.sessionManager.getSessionId(),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) this.sessionManager.appendLabelChange(summaryId, label);
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			this._scheduleIdleCompaction(); // The selected branch has its own latest request and deadline.
			// The new leaf is installed: session_tree handlers may prompt or navigate again.
			this._branchSummaryAbortController = undefined;
			releaseTurnStart();
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			if (this._branchSummaryAbortController === branchSummaryAbortController) {
				this._branchSummaryAbortController = undefined;
			}
		}
	}

	/** Get all user messages from session for fork selector. */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/** Get session statistics. */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const tokens = estimateBranchContextTokens(this.sessionManager.getBranch(), this.messages);
		return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of the last assistant reply.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists or the last reply has no text
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip text-less messages that did not end normally: aborted, failed, or only calling tools (end_turn).
				if (msg.stopReason !== "stop" && !msg.content.some((c) => c.type === "text" && c.text.trim())) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(structuredClone(message), options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(structuredClone(content), options);
		return context;
	}

	/** Check if extensions have handlers for a specific event type. */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/** Get the extension runner (for setting UI context and error handlers). */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
