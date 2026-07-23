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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	Agent,
	AgentContext,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
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
	isContextOverflow,
	isRetryableAssistantError,
	modelsAreEqual,
	resetApiProviders,
	streamSimple,
	validateToolArguments,
} from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { reviewToolCallWithSupervisor } from "../supervisor/approval-reviewer.ts";
import { requestSupervisorDecision } from "../supervisor/client.ts";
import { DEFAULT_SUPERVISOR_KB_DIR, resolveSupervisorProjectForCwd } from "../supervisor/project-resolver.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
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
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { sendDesktopNotification } from "./desktop-notification.ts";
import { createDetachedJobLifecycleController } from "./detached-job-lifecycle.ts";
import type { DetachedJobLifecycleController } from "./detached-job-runner.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
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
	type ReplacedSessionContext,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolCallEvent,
	type ToolCallEventResult,
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
import type { ApprovalReviewerResult as ExtensionApprovalReviewerResult } from "./extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "./footer-data-provider.ts";
import { LifecycleCoordinator } from "./lifecycle-coordinator.ts";
import { type BashExecutionMessage, type CustomMessage, createCompactionSummaryMessage } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { findExactModelReferenceMatch, resolveModelScope, type ScopedModel } from "./model-resolver.ts";
import type {
	AgentCurrentActivityOwner,
	AgentLifecycleState,
	AgentSnapshot,
	MultiAgentStore,
	SteeringCheckpoint,
} from "./multi-agent-store.ts";
import { createPermissionPromptHandler } from "./permissions/mcp-permission-prompt.ts";
import { type ApprovalReviewer, orchestrateToolApproval } from "./permissions/orchestrator.ts";
import { approvalPresetToBypassPermissions } from "./permissions/presets.ts";
import { PermissionRuleStore } from "./permissions/rule-store.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { formatRuntimeMailboxPrompt, formatSharedChannelPrompt } from "./runtime-coordination-format.ts";
import { readProcessIdentity } from "./runtime-process.ts";

const BUILT_IN_COMPACTION_DISABLED_MESSAGE =
	"Built-in compaction is disabled; enable compaction or configure a compaction extension";

function findLastUserText(messages: unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) continue;
		return message.content
			.filter(
				(part): part is { text: string; type: "text" } =>
					isRecord(part) && part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("");
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
	advanceSharedChannelCursor,
	cleanupMultiAgentTerminalOutbox,
	getControlDbPath,
	initializeSharedChannelCursorAtTail,
	listSharedChannelMessagesAfter,
	markMultiAgentMailboxMessageDelivered,
	markMultiAgentMailboxMessageFailed,
	type RuntimeMailboxAddress,
	type RuntimeMailboxMessage,
	readMultiAgentRuntimeOwnership,
	readRuntimeMailboxListener,
	readSharedChannelTail,
	recordPromptHistoryEntry,
	registerRuntimeMailboxListener,
	removeNamedSession,
	retainControlDbConnection,
	retireRuntimeMailboxListener,
	type SharedChannelMessage,
	setNamedSession,
	takeRuntimeMailboxMessagesForDelivery,
	writeLastMessage,
} from "./session-control-db.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";

import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS, type SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import {
	deliverTerminalOutboxProjections,
	isTerminalOutboxCleanupDue,
	terminalOutboxRetentionThreshold,
} from "./terminal-outbox-delivery.ts";

export { type ParsedSkillBlock, parseSkillBlock } from "./skill-block.ts";

import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { ToolDetachRegistry } from "./tool-detach-registry.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions, DEFAULT_ACTIVE_TOOL_NAMES } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

const MCP_TOOL_NAME_PATTERN = /^mcp__[^_]+(?:_[^_]+)*__[^_]+(?:_[^_]+)*$/;
const PERMISSION_PROMPT_TOOL_NAME = "approval_prompt";
const PERMISSION_PROMPT_SCHEMA_FIELDS = ["tool_name", "input", "tool_use_id", "cwd"] as const;
const RUNTIME_MAILBOX_POLL_INTERVAL_MS = 30_000;
const RUNTIME_MAILBOX_HEARTBEAT_INTERVAL_MS = 60_000;

function readHeadlessToolAutoDetachAfterMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const value = env.PI_HEADLESS_TOOL_AUTO_DETACH_MS;
	if (value === undefined) return undefined;
	const milliseconds = Number(value);
	if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
		throw new Error(`PI_HEADLESS_TOOL_AUTO_DETACH_MS must be a positive integer: ${value}`);
	}
	return milliseconds;
}

async function waitForHeadlessSessionStartRelease(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const releasePath = env.PI_HEADLESS_SESSION_START_RELEASE_PATH;
	if (releasePath === undefined) return;
	if (!releasePath) throw new Error("PI_HEADLESS_SESSION_START_RELEASE_PATH must be non-empty");
	writeFileSync(`${releasePath}.ready`, "ready");
	while (!existsSync(releasePath)) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
const CODEX_PROVIDER_PAIRS = new Map([
	["openai-codex", "openai-codex-gc"],
	["openai-codex-gc", "openai-codex"],
]);
const QUOTA_EXHAUSTION_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|usage limit|available balance|insufficient_quota|out of budget|quota exceeded|billing (?:limit|quota|exhausted)/i;

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

function isPermissionPromptProtocolTool(tool: AgentTool): boolean {
	if (!MCP_TOOL_NAME_PATTERN.test(tool.name)) {
		return false;
	}

	const toolName = tool.name.split("__")[2];
	return toolName === PERMISSION_PROMPT_TOOL_NAME && hasPermissionPromptSchema(tool.parameters);
}

function hasPermissionPromptSchema(parameters: unknown): boolean {
	const schema = toRecord(parameters);
	const properties = toRecord(schema?.properties);
	return PERMISSION_PROMPT_SCHEMA_FIELDS.every((field) => properties !== undefined && field in properties);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	return value as Record<string, unknown>;
}

function buildAllowAlwaysAgentPrompt(input: { cwd: string; input: Record<string, unknown>; toolName: string }): string {
	return [
		"Add a persistent allow rule for a command that was approved with Allow always in Pi.",
		"",
		"Target project: /syncthing/Sync/Projects/claude/claude-bash-hook",
		`Original cwd: ${input.cwd}`,
		`Tool name: ${input.toolName}`,
		"Tool input:",
		JSON.stringify(input.input, null, 2),
		"",
		"Requirements:",
		"- Add the narrowest safe allow rule for this exact workflow.",
		"- Do not broaden access beyond what the approved command requires.",
		"- Preserve deny/protected-path precedence.",
		"- Run the relevant claude-bash-hook tests/checks.",
		"- Commit the verified config or code change if repository rules allow committing.",
	].join("\n");
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "steering_message_queued" }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow"; sourceHint?: CompactionSourceInfo }
	| { type: "entry_appended"; entry: SessionEntry }
	/** Emitted after bash messages are appended to agent state and session storage. */
	| { type: "bash_messages_committed"; messages: readonly BashExecutionMessage[] }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	/** Provider-internal retry or transport fallback inside a single stream request. */
	| { type: "provider_stream_retry"; retry: ProviderRetryEvent };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export type MultiAgentRuntimeRole = "standalone" | "orchestrator" | "child" | "observer";

export interface MultiAgentExecutionCapability {
	readonly kind: "multi-agent-execution";
}

const issuedMultiAgentExecutionCapabilities = new WeakSet<MultiAgentExecutionCapability>();

export function createMultiAgentExecutionCapability(): MultiAgentExecutionCapability {
	const capability: MultiAgentExecutionCapability = Object.freeze({ kind: "multi-agent-execution" });
	issuedMultiAgentExecutionCapabilities.add(capability);
	return capability;
}

export type SupervisorDecisionRequester = typeof requestSupervisorDecision;

const THINKING_PHASE_TIMEOUT_MS = 15 * 60 * 1000;
const SUPERVISOR_AUTO_APPROVED_READ_ONLY_TOOLS = new Set([
	"find",
	"grep",
	"ls",
	"outline",
	"read",
	"references",
	"symbol",
]);

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
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

type SessionMutationTargetResolver = () => ViewedSessionMutationTarget | undefined;
const sessionMutationTargetResolvers = new WeakMap<AgentSession, SessionMutationTargetResolver>();

export function bindAgentSessionMutationTargetResolver(
	session: AgentSession,
	resolver: SessionMutationTargetResolver,
): void {
	sessionMutationTargetResolvers.set(session, resolver);
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
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
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

function findTrailingAssistantToolBatch(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "toolResult") continue;
		return message.role === "assistant" ? message : undefined;
	}
	return undefined;
}

export function shouldContinueInterruptedSession(messages: readonly AgentMessage[]): boolean {
	const lastMessage = messages[messages.length - 1];
	if (lastMessage?.role === "user") return true;
	if (lastMessage?.role !== "assistant" && lastMessage?.role !== "toolResult") return false;
	const assistant =
		lastMessage.role === "assistant" ? lastMessage : findTrailingAssistantToolBatch(messages.slice(0, -1));
	if (!assistant) return lastMessage.role === "toolResult";
	if (assistant.stopReason === "aborted") return true;
	const toolCalls = assistant.content.filter((content) => content.type === "toolCall");
	return toolCalls.length > 0 && toolCalls.every((content) => content.name !== "resume_session");
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
	return message.sender.sessionId === recipient.sessionId && message.sender.agentId === recipient.agentId;
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

function validateMultiAgentRuntimeRole(config: AgentSessionConfig): void {
	const role = config.multiAgentRuntimeRole ?? "standalone";
	const capability = config.multiAgentExecutionCapability;
	const hasIssuedCapability = capability !== undefined && issuedMultiAgentExecutionCapabilities.has(capability);
	if (role === "orchestrator" && !hasIssuedCapability) {
		throw new Error("Multi-agent orchestrator requires an issued execution capability");
	}
	if (role !== "orchestrator" && capability !== undefined) {
		throw new Error(`Multi-agent ${role} runtime cannot receive execution capability`);
	}
}

// ============================================================================
// AgentSession Class
// ============================================================================

/**
 * Custom session-entry type recording the terminal outcome of a detached tool
 * call (e.g. a Pyrun/Bash job that was moved to the background). The original
 * tool_result is immutable at "detached", so this entry carries the eventual
 * outcome keyed by the originating toolCallId for correlation in the transcript.
 */
export const DETACHED_TOOL_CALL_COMPLETION_CUSTOM_TYPE = "detached_tool_call_completion";

export interface DetachedToolCallCompletionEntryData {
	toolCallId: string;
	agentId: string;
	lifecycle: "completed" | "failed" | "aborted";
	summary?: string;
	error?: string;
}

/**
 * Builds the transcript entry data for a detached tool call's terminal outcome,
 * or undefined when the agent is not a terminal detached tool-call job (no
 * originating toolCallId on its active worker or terminal result, or still active).
 */
export function buildDetachedToolCallCompletionEntry(
	agent: AgentSnapshot | undefined,
): DetachedToolCallCompletionEntryData | undefined {
	const toolCallId = agent?.worker?.toolCallId ?? agent?.result?.toolCallId;
	if (!agent || !toolCallId) return undefined;
	if (agent.lifecycle !== "completed" && agent.lifecycle !== "failed" && agent.lifecycle !== "aborted") {
		return undefined;
	}
	return {
		agentId: agent.id,
		lifecycle: agent.lifecycle,
		toolCallId,
		...(agent.result?.summary === undefined ? {} : { summary: agent.result.summary }),
		...(agent.error?.message === undefined ? {} : { error: agent.error.message }),
	};
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** User prompts held outside Agent queues, such as TUI input replay after abort. */
	private _externalUserInputReservations = 0;
	/** Serializes turn-start checks through the Agent core transition. */
	private _turnStartLockTail: Promise<void> = Promise.resolve();

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private _lengthRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _quotaFallbackAttempted = false;

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private readonly _toolDetachRegistry = new ToolDetachRegistry({
		autoDetachAfterMs: readHeadlessToolAutoDetachAfterMs(),
	});
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
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _runtimeMailboxPollTimer?: ReturnType<typeof setInterval>;
	private _runtimeMailboxControlDbPath?: string;
	private _runtimeMailboxControlDbRelease?: () => void;
	private _runtimeMailboxHeartbeatTimer?: ReturnType<typeof setInterval>;
	private _runtimeMailboxSignalHandler?: () => void;
	private _disposed = false;
	private _runtimeMailboxDrainPromise: Promise<boolean> | undefined;
	private _runtimeMailboxDrainMode: "prompt" | "steer" | undefined;
	private _sharedChannelDrainInProgress = false;
	private _runtimeMailboxSteeringAgentIds = new Set<string>();
	private readonly _runtimeMailboxPendingTerminal = new Map<
		string,
		{ lifecycle: "completed" | "failed" | "aborted"; summary?: string }
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
	private readonly _detachedJobProcessIdentity = readProcessIdentity(process.pid);
	private readonly _terminalOutboxClaimId = randomUUID();
	private _terminalOutboxLastCleanupAt: number | undefined;
	private _multiAgentAgentId: string | undefined;
	private readonly _multiAgentActiveTools = new Map<
		string,
		{ startedAt: string; toolCallId: string; toolName: string }
	>();
	private _multiAgentParentSessionId: string | undefined;
	private _multiAgentRequiresAgentId: boolean;
	private readonly _thinkingPhaseTimeoutMs: number;
	private _thinkingPhaseTimer: ReturnType<typeof setTimeout> | undefined;
	private _thinkingPhaseTimeoutError: Error | undefined;
	private _disableRuntimeCoordinationInbound: boolean;
	private _systemPromptOverride?: string;

	constructor(config: AgentSessionConfig) {
		validateMultiAgentRuntimeRole(config);
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
		this._disableRuntimeCoordinationInbound = config.disableRuntimeCoordinationInbound ?? false;
		this._multiAgentStore = config.multiAgentStore;
		this._agentDir = config.agentDir ?? getAgentDir();
		this._controlDbPath = this.sessionManager.getMetadataControlDbPath() ?? getControlDbPath();
		this._supervisorDecisionRequester = config.supervisorDecisionRequester ?? requestSupervisorDecision;
		this._permissionRuleStore = new PermissionRuleStore({
			agentDir: this._agentDir,
			cwd: this._cwd,
			settings: this.settingsManager.getMergedSettings(),
		});
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this.sessionManager.setMetadataControlDbPath(this._controlDbPath);

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();

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

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
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

	private async _getCompactionRequestAuth(model: Model<any>): Promise<{
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
		reason: "manual" | "threshold" | "overflow",
		willRetry: boolean,
	): Promise<CompactionSourceInfo | undefined> {
		if (!this.model) {
			return undefined;
		}

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
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			const event = {
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				bypassPermissions: approvalPresetToBypassPermissions(this.settingsManager.getApprovalPreset()),
				input: args as Record<string, unknown>,
			} as const;
			const gateResult = await this._reviewToolGates(event, runner);
			if (gateResult?.block) {
				return gateResult;
			}

			const approvalRequired = this._toolDefinitions.get(toolCall.name)?.definition.approvalRequired ?? true;
			const policy = this.settingsManager.getApprovalPolicy();
			const autoApproveReviewResult =
				policy === "auto-approve"
					? await this._reviewAutoApprovedToolCall(event, runner, approvalRequired)
					: undefined;
			if (autoApproveReviewResult) {
				return autoApproveReviewResult;
			}

			return orchestrateToolApproval({
				policy,
				approvalRequired,
				hookReviewer: this._createToolApprovalHookReviewer(event, runner),
				reviewer: this._createToolApprovalHumanReviewer(event, runner),
				llmReviewer: this._createToolApprovalLlmReviewer(event),
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

	private async _reviewToolGates(
		event: ToolCallEvent,
		runner: ExtensionRunner,
	): Promise<ToolCallEventResult | undefined> {
		if (!runner.hasToolGates()) {
			return undefined;
		}

		try {
			return await runner.emitToolGates(event);
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	}

	private async _reviewAutoApprovedToolCall(
		event: ToolCallEvent,
		runner: ExtensionRunner,
		approvalRequired: boolean,
	): Promise<ToolCallEventResult | undefined> {
		if (!approvalRequired || !runner.hasApprovalReviewers()) {
			return undefined;
		}

		const reviewerResult = await runner.emitApprovalReviewers(event);
		if (reviewerResult?.action === "deny") {
			return { block: true, reason: reviewerResult.reason };
		}

		return undefined;
	}

	private _createToolApprovalHookReviewer(
		event: ToolCallEvent,
		runner: ExtensionRunner,
	): ApprovalReviewer | undefined {
		const permissionPromptTool = this._resolvePermissionPromptTool();
		if (!runner.hasApprovalReviewers() && !permissionPromptTool && !runner.hasHandlers("tool_call")) {
			return undefined;
		}

		return async () => {
			const approvalReviewerResult = await this._reviewRegisteredApprovalReviewers(event, runner);
			if (approvalReviewerResult) {
				return approvalReviewerResult;
			}

			const permissionPromptResult = await createPermissionPromptHandler({
				permissionPromptTool,
				cwd: this._cwd,
				desktopNotifier: sendDesktopNotification,
				ruleStore: this._permissionRuleStore,
				callTool: async (permissionPromptTool, input) => {
					const tool = this._toolRegistry.get(permissionPromptTool);
					if (!tool) {
						throw new Error(`Permission prompt tool not found: ${permissionPromptTool}`);
					}
					return tool.execute(`permission-prompt:${input.tool_use_id}`, input as never);
				},
			})(event);
			if (permissionPromptResult?.block) {
				return permissionPromptResult;
			}

			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall(event);
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};
	}

	private async _reviewRegisteredApprovalReviewers(
		event: ToolCallEvent,
		runner: ExtensionRunner,
	): Promise<ToolCallEventResult | undefined> {
		if (!runner.hasApprovalReviewers()) {
			return undefined;
		}

		const reviewerResult = await runner.emitApprovalReviewers(event);
		return this._toToolCallResultFromApprovalReviewer(event, runner, reviewerResult);
	}

	private async _toToolCallResultFromApprovalReviewer(
		event: ToolCallEvent,
		runner: ExtensionRunner,
		reviewerResult: ExtensionApprovalReviewerResult | undefined,
	): Promise<ToolCallEventResult | undefined> {
		if (!reviewerResult) {
			return undefined;
		}
		if (reviewerResult.action === "allow") {
			return { block: false };
		}

		if (reviewerResult.action === "deny") {
			return { block: true, reason: reviewerResult.reason };
		}

		const humanReviewer = this._createToolApprovalHumanReviewer(event, runner, reviewerResult.reason);
		if (!humanReviewer) {
			return { block: true, reason: reviewerResult.reason ?? "Approval required" };
		}
		return (await humanReviewer()) ?? { block: false };
	}

	private _resolvePermissionPromptTool(): string | undefined {
		if (this._permissionPromptTool) {
			return this._permissionPromptTool;
		}

		const discoveredTools = Array.from(this._toolRegistry.values())
			.filter(isPermissionPromptProtocolTool)
			.map((tool) => tool.name);

		return discoveredTools.length === 1 ? discoveredTools[0] : undefined;
	}

	private _createToolApprovalHumanReviewer(
		event: ToolCallEvent,
		runner: ExtensionRunner,
		reason?: string,
		force = false,
	): ApprovalReviewer | undefined {
		const approvalPreset = this.settingsManager.getApprovalPreset();
		if ((!force && approvalPreset !== "ask-me" && approvalPreset !== "llm-approved-ask") || !runner.hasUI()) {
			return undefined;
		}

		return async () => {
			const reasonText = reason ? `\nReason: ${reason}` : "";
			const selection = await runner
				.getUIContext()
				.select(`Approve ${event.toolName}?${reasonText}\n${JSON.stringify(event.input, null, 2)}`, [
					"Allow once",
					"Allow always",
					"Deny",
				]);
			if (selection === "Allow once") {
				return undefined;
			}
			if (selection === "Allow always") {
				this._spawnAllowAlwaysAgent(event);
				return undefined;
			}
			return { block: true, reason: "Tool call rejected by user" };
		};
	}

	private _spawnAllowAlwaysAgent(event: ToolCallEvent): void {
		const tool = this._toolRegistry.get("spawn_agent");
		if (!tool) {
			return;
		}

		void tool
			.execute(`allow-always:${event.toolCallId}`, {
				agentType: "permission-config",
				displayName: "Allow command",
				prompt: buildAllowAlwaysAgentPrompt({
					cwd: this._cwd,
					input: event.input,
					toolName: event.toolName,
				}),
			})
			.catch((error: unknown) => {
				console.error("Failed to spawn allow-always agent:", error);
			});
	}

	private _createToolApprovalLlmReviewer(event: ToolCallEvent): ApprovalReviewer | undefined {
		const approvalPreset = this.settingsManager.getApprovalPreset();
		if (approvalPreset !== "llm-approved-deny" && approvalPreset !== "llm-approved-ask") return undefined;
		const approvalKind = this._toolDefinitions.get(event.toolName)?.definition.approvalKind;
		if (approvalKind === "read-only" && SUPERVISOR_AUTO_APPROVED_READ_ONLY_TOOLS.has(event.toolName)) {
			return async () => undefined;
		}

		return async () => {
			const kbDir = process.env.PI_KB_DIR ?? DEFAULT_SUPERVISOR_KB_DIR;
			return reviewToolCallWithSupervisor(
				() =>
					this._supervisorDecisionRequester({
						controlDbPath: this._controlDbPath,
						kind: "approval_review",
						payload: {
							activeGoal: this.sessionManager.getSessionGoalJson(),
							currentUserRequest: findLastUserText(this.agent.state.messages),
							input: event.input,
							preset: approvalPreset,
							toolCallId: event.toolCallId,
							toolName: event.toolName,
						},
						projectId: resolveSupervisorProjectForCwd(this._cwd, kbDir),
						senderSessionId: this.sessionId,
						timeoutMs: 30_000,
					}),
				async (reason) => {
					const humanReviewer = this._createToolApprovalHumanReviewer(event, this._extensionRunner, reason, true);
					return humanReviewer ? await humanReviewer() : { block: true, reason };
				},
				approvalPreset === "llm-approved-ask",
			);
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;
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

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		this._publishCurrentAgentActivity(event);

		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			this._lengthRecoveryAttempted = false;
			this._quotaFallbackAttempted = false;
			const messageText = this._getUserMessageText(event.message);
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;
				this._writeLastAssistantControlMessage(event.message);

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecoveryAttempted = false;
				}
				if (assistantMsg.stopReason !== "length") {
					this._lengthRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
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

	private _startThinkingPhaseDeadline(): void {
		if (this._multiAgentRuntimeRole === "observer" || this._thinkingPhaseTimeoutMs <= 0) return;
		this._clearThinkingPhaseDeadline();
		this._thinkingPhaseTimer = setTimeout(() => {
			this._thinkingPhaseTimer = undefined;
			const subject = this._multiAgentAgentId ? "Child agent" : "Main session";
			this._thinkingPhaseTimeoutError = new Error(`${subject} thinking phase exceeded 15 minutes`);
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
				store.publishAgentCurrentActivity(
					agentId,
					{ phase: "thinking", startedAt: new Date().toISOString() },
					ownership,
				);
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
		const summary = lifecycle === "completed" ? this._lastRuntimeMailboxAssistantText(messages) : undefined;
		for (const agentId of this._runtimeMailboxSteeringAgentIds) {
			if (this._completeRuntimeMailboxSteeredAgent(agentId, lifecycle, summary)) continue;
			if (!this._isTerminalMultiAgentLifecycle(lifecycle)) continue;
			const hasActiveDescendants = this._multiAgentStore
				.listDescendants(agentId)
				.some((agent) => !this._isTerminalMultiAgentLifecycle(agent.lifecycle));
			if (hasActiveDescendants) this._deferRuntimeMailboxSteeredTerminal(agentId, lifecycle, summary);
		}
		this._runtimeMailboxSteeringAgentIds.clear();
	}

	private _completeRuntimeMailboxSteeredAgent(
		agentId: string,
		lifecycle: AgentLifecycleState,
		summary: string | undefined,
	): boolean {
		if (!this._multiAgentStore) {
			return false;
		}
		const current = this._multiAgentStore.getAgent(agentId);
		if (!current || this._isTerminalMultiAgentLifecycle(current.lifecycle)) {
			return true;
		}
		if (!this._isTerminalMultiAgentLifecycle(lifecycle)) return true;
		const result = summary ? { summary } : undefined;
		const error = lifecycle === "failed" ? { message: "Runtime mailbox steering turn failed" } : undefined;
		if (!this._finalizeReservedMultiAgent(current, lifecycle, { error, result })) {
			return false;
		}
		return true;
	}

	private _deferRuntimeMailboxSteeredTerminal(
		agentId: string,
		lifecycle: "completed" | "failed" | "aborted",
		summary: string | undefined,
	): void {
		if (!this._multiAgentStore) return;
		this._runtimeMailboxPendingTerminal.set(agentId, { lifecycle, summary });
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
			if (!this._completeRuntimeMailboxSteeredAgent(agentId, pending.lifecycle, pending.summary)) {
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

	private _lastRuntimeMailboxAssistantText(messages: AgentMessage[]): string | undefined {
		const assistant = this._lastRuntimeMailboxAssistant(messages);
		if (!assistant) {
			return undefined;
		}
		const text = getAssistantMessageText(assistant).trim();
		return text.length > 0 ? text : undefined;
	}

	private _lastRuntimeMailboxAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role !== "assistant") {
				continue;
			}

			const assistant = message as AssistantMessage;
			if (this._findQuotaFallbackModel(assistant)) {
				return true;
			}
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
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
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

		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (latestUserIndex === -1 && message.role === "user") {
				latestUserIndex = i;
			}
			if (latestAssistantIndex === -1 && message.role === "assistant") {
				latestAssistantIndex = i;
				const assistant = message as AssistantMessage;
				if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
					return true;
				}
			}
			if (latestCompletedAssistantIndex === -1 && message.role === "assistant") {
				const assistant = message as AssistantMessage;
				if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
					latestCompletedAssistantIndex = i;
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

	private async _continueAgentWithThinkingTimeout(): Promise<void> {
		try {
			await this.agent.continue();
		} catch (error) {
			throw this._consumeThinkingPhaseTimeoutError() ?? error;
		}
		const timeoutError = this._consumeThinkingPhaseTimeoutError();
		if (timeoutError) throw timeoutError;
	}

	private async _continuePostAgentRunsWhileHoldingTurnStartLock(): Promise<void> {
		while (await this._handlePostAgentRun()) {
			await this._continueAgentWithThinkingTimeout();
		}
	}

	private async _continueAfterManualCompaction(
		removeToolUseAssistant: boolean,
		turnStartLockHeld = false,
	): Promise<void> {
		const continueAfterCompaction = async (): Promise<void> => {
			if (this.isStreaming) {
				throw new Error("Agent is already processing. Wait for completion before continuing.");
			}

			this._removeTrailingInterruptedAssistant(removeToolUseAssistant);
			await this._continueAgentWithThinkingTimeout();
			if (turnStartLockHeld) {
				await this._continuePostAgentRunsWhileHoldingTurnStartLock();
			} else {
				await this._continuePostAgentRuns();
			}
		};

		if (turnStartLockHeld) {
			try {
				await continueAfterCompaction();
			} finally {
				this._flushPendingBashMessages();
			}
			return;
		}

		await this._withTurnStartLock(async (release) => {
			const continuation = continueAfterCompaction();
			release();
			try {
				await continuation;
			} finally {
				this._flushPendingBashMessages();
			}
		});
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
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
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

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._clearThinkingPhaseDeadline();
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
	get model(): Model<any> | undefined {
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

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
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

	private async _callActiveTool(
		toolName: string,
		params: unknown,
		signal: AbortSignal | undefined,
		activeToolCallId?: string,
	): Promise<AgentToolResult<unknown>> {
		if (!this.getActiveToolNames().includes(toolName)) {
			throw new Error(`Tool is not active: ${toolName}`);
		}
		if (toolName === "pyrun_eval") {
			throw new Error("pyrun_eval cannot call itself through pi.tools.call");
		}
		const tool = this._toolRegistry.get(toolName);
		if (!tool) {
			throw new Error(`Tool is not registered: ${toolName}`);
		}

		const toolCallId = activeToolCallId ?? `pyrun:${toolName}:${Date.now()}`;
		let toolCall = this._createSyntheticToolCall(toolName, toolCallId, params);
		if (tool.prepareArguments) {
			toolCall = this._createSyntheticToolCall(toolName, toolCallId, tool.prepareArguments(toolCall.arguments));
		}
		const validatedArgs = validateToolArguments(tool, toolCall) as unknown;
		const context = this._createSyntheticToolCallContext();
		const assistantMessage = this._createSyntheticToolCallAssistantMessage(toolCall);
		const beforeResult = await this.agent.beforeToolCall?.(
			{ assistantMessage, args: validatedArgs, context, toolCall },
			signal,
		);
		if (beforeResult?.block) {
			return this._createErrorToolResult(beforeResult.reason ?? "Tool execution was blocked");
		}

		let result: AgentToolResult<unknown>;
		let isError = false;
		try {
			result = await tool.execute(toolCallId, validatedArgs as never, signal);
			isError = result.isError ?? false;
		} catch (error) {
			result = this._createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}

		const afterResult = await this.agent.afterToolCall?.(
			{ assistantMessage, args: validatedArgs, context, isError, result, toolCall },
			signal,
		);
		return afterResult ? { ...result, ...afterResult } : result;
	}

	private _createErrorToolResult(message: string): AgentToolResult<undefined> {
		return {
			content: [{ type: "text", text: message }],
			details: undefined,
			isError: true,
		};
	}

	private _createSyntheticToolCall(toolName: string, toolCallId: string, params: unknown): AgentToolCall {
		const toolArguments =
			params && typeof params === "object" ? (params as Record<string, unknown>) : { value: params };
		return {
			type: "toolCall",
			id: toolCallId,
			name: toolName,
			arguments: toolArguments,
		};
	}

	private _createSyntheticToolCallAssistantMessage(toolCall: AgentToolCall): AssistantMessage {
		return {
			role: "assistant",
			content: [toolCall],
			api: this.model?.api ?? "openai-completions",
			provider: this.model?.provider ?? "pyrun",
			model: this.model?.id ?? "pyrun-tools-call",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
	}

	private _createSyntheticToolCallContext(): AgentContext {
		return {
			systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
			messages: this.agent.state.messages,
			tools: this.agent.state.tools,
		};
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
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

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
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
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
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
	): Promise<void> {
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

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._thinkingPhaseTimeoutError = undefined;
		try {
			try {
				await this.agent.prompt(messages);
			} catch (error) {
				throw this._consumeThinkingPhaseTimeoutError() ?? error;
			}
			const timeoutError = this._consumeThinkingPhaseTimeoutError();
			if (timeoutError) throw timeoutError;
			await this._continuePostAgentRuns();
		} finally {
			this._clearThinkingPhaseDeadline();
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
		}
	}

	private async _runAgentContinuation(): Promise<void> {
		this._thinkingPhaseTimeoutError = undefined;
		try {
			try {
				await this.agent.continue();
			} catch (error) {
				throw this._consumeThinkingPhaseTimeoutError() ?? error;
			}
			const timeoutError = this._consumeThinkingPhaseTimeoutError();
			if (timeoutError) throw timeoutError;
			await this._continuePostAgentRuns();
		} finally {
			this._clearThinkingPhaseDeadline();
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
		}
	}

	private async _continuePostAgentRuns(): Promise<void> {
		while (
			await this._withTurnStartLock(async (release) => {
				if (!(await this._handlePostAgentRun())) {
					return false;
				}
				const continuation = this._continueAgentWithThinkingTimeout();
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

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (await this._prepareQuotaFallback(msg)) {
			return true;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		if (this.agent.hasQueuedMessages()) {
			return true;
		}

		return this._drainRuntimeCoordinationMessages({ checkpoint: "next_model_call", triggerIfIdle: false });
	}

	/**
	 * Continue the agent from the current transcript without adding a user message.
	 * @throws Error if streaming, no model is selected, or no API key is available
	 */
	async continue(): Promise<void> {
		await this._withTurnStartLock(async (release) => {
			if (this.isStreaming) {
				throw new Error("Agent is already processing. Wait for completion before continuing.");
			}

			this._flushPendingBashMessages();

			const lastMessage = this.messages[this.messages.length - 1];
			if (!lastMessage) {
				return;
			}

			this.validateModelAuthentication();

			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

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
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this._tryExecuteExtensionCommand(text);
			if (handled) {
				this._recordHandledSlashCommandHistory(text);
				options?.preflightResult?.(true);
				return;
			}
			if (!this._isKnownSlashCommand(text)) {
				throw new Error(`Unknown slash command: ${this._slashCommandName(text)}`);
			}
		}

		await this._withTurnStartLock((release) => this._promptTurn(text, options, release));
		await this._drainRuntimeCoordinationMessages({ triggerIfIdle: true });
	}

	private async _promptTurn(
		text: string,
		options: PromptOptions | undefined,
		releaseTurnStart: () => void,
	): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

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
				);
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

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
			messages.push({
				role: "user",
				content: userContent,
				inputSource: options?.source,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						content: msg.content,
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// Apply extension-modified system prompt, or reset to base
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// Ensure we're using the base prompt (in case previous turn had modifications)
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		preflightResult?.(true);
		const run = this._runAgentPrompt(messages);
		releaseTurnStart();
		try {
			await run;
		} finally {
			this._completeRuntimeMailboxSteeringTurn(this.messages);
		}
	}

	private _recordHandledSlashCommandHistory(text: string): void {
		try {
			recordPromptHistoryEntry(this._controlDbPath, text);
		} catch (error) {
			console.error(
				"Failed to persist prompt history for handled slash command:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
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

	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getPromptCommand(commandName);
		if (!command) return false;

		try {
			await command.handler(args, this._createCommandContext(commandName));
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _createCommandContext(commandName: string): ExtensionCommandContext {
		const context = this._extensionRunner.createCommandContext();
		if (this._multiAgentAgentId || (commandName !== "model" && commandName !== "effort")) return context;
		return this._createViewedSessionCommandContext(context);
	}

	private _createViewedSessionCommandContext(context: ExtensionCommandContext): ExtensionCommandContext {
		const owningModel = context.model;
		const owningModelRegistry = context.modelRegistry;
		const owningScopedModels = context.getScopedModels;
		const owningGetThinkingLevel = context.getThinkingLevel;
		const owningSetModel = context.setModel;
		const owningSetThinkingLevel = context.setThinkingLevel;
		const resolveViewedTarget = (): ViewedSessionMutationTarget | undefined =>
			sessionMutationTargetResolvers.get(this)?.();

		Object.defineProperty(context, "model", {
			configurable: true,
			enumerable: true,
			get: () => {
				const target = resolveViewedTarget();
				return target ? target.model : owningModel;
			},
		});
		Object.defineProperty(context, "modelRegistry", {
			configurable: true,
			enumerable: true,
			get: () => {
				const target = resolveViewedTarget();
				return target ? target.modelRegistry : owningModelRegistry;
			},
		});
		context.getScopedModels = () => {
			const target = resolveViewedTarget();
			return target ? target.scopedModels : (owningScopedModels?.() ?? []);
		};
		context.getThinkingLevel = () => resolveViewedTarget()?.thinkingLevel ?? owningGetThinkingLevel();
		context.setModel = async (model) => {
			const target = resolveViewedTarget();
			if (!target) return owningSetModel(model);
			await target.setModel(model);
			return true;
		};
		context.setThinkingLevel = (level) => {
			const target = resolveViewedTarget();
			if (target) target.setThinkingLevel(level);
			else owningSetThinkingLevel(level);
		};
		return context;
	}

	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

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

	/**
	 * Queue a steering message while the agent is running.
	 * Interrupts active model thinking and restarts with the message. Active tool
	 * execution finishes before the message is delivered to the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._withTurnStartLock(async (release) => {
			if (this.isStreaming) {
				await this._queueSteer(expandedText, images);
				return;
			}

			this.validateModelAuthentication();
			await this._queueSteer(expandedText, images);
			const continuation = this._runAgentContinuation();
			release();
			void continuation.catch((error) => {
				console.error(`Failed to continue idle steering: ${errorMessage(error)}`);
			});
		});
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private _steerAgent(message: AgentMessage): void {
		this.agent.steer(message);
		if (this._multiAgentActiveTools.size === 0) this._startThinkingPhaseDeadline();
	}

	private async _queueSteer(text: string, images?: ImageContent[], inputSource?: InputSource): Promise<void> {
		this._steeringMessages.push(text);
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

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[], inputSource?: InputSource): Promise<void> {
		this._followUpMessages.push(text);
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
		const store = this._multiAgentStore;
		const persistence = store?.getPersistenceTarget();
		const controlDbPath = this._getRuntimeMailboxControlDbPath();
		if (!store || !persistence || !controlDbPath) return undefined;
		const coordinator = new LifecycleCoordinator({
			controlDbPath,
			createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
			now: () => new Date().toISOString(),
			processIdentity: this._detachedJobProcessIdentity,
			sessionPath: persistence.sessionPath,
		});
		return createDetachedJobLifecycleController({
			artifactRoot: this._agentDir,
			controlDbPath,
			coordinator,
			ownerAgentId: this._multiAgentAgentId,
			ownerSessionId: this.sessionId,
			sessionPath: persistence.sessionPath,
			store,
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
			if (!canSteerActiveTurn) return false;
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

	private async _deliverReadyRuntimeMailboxMessages(
		controlDbPath: string,
		options: { checkpoint?: SteeringCheckpoint; includeNextModelCall?: boolean; triggerIfIdle: boolean },
		delivery: { mode: "steer" } | { mode: "prompt"; releaseMailboxDrain: () => void; releaseTurnStart: () => void },
	): Promise<boolean> {
		if (delivery.mode === "prompt" && (!this.model || !this._modelRegistry.hasConfiguredAuth(this.model))) {
			return false;
		}
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
		const promptMessages: RuntimeMailboxMessage[] = [];
		for (const message of messages) {
			this._recordDetachedToolCallCompletion(message);
			if (await this._interceptRuntimeMailboxMessage(message)) continue;
			promptMessages.push(message);
		}
		if (promptMessages.length === 0) return false;
		const prompt = promptMessages
			.map((message) => formatRuntimeMailboxPrompt(message, recipient.sessionId))
			.join("\n\n");
		if (delivery.mode === "steer") {
			this._steerAgent({
				role: "user",
				content: [{ type: "text", text: prompt }],
				inputSource: "extension",
				timestamp: Date.now(),
			});
			for (const message of promptMessages) this._markStoreMailboxMessageDelivered(message);
			return true;
		}
		delivery.releaseMailboxDrain();
		await this._promptTurn(prompt, { expandPromptTemplates: false, source: "extension" }, delivery.releaseTurnStart);
		for (const message of promptMessages) this._markStoreMailboxMessageDelivered(message);
		this._completeRuntimeMailboxSteeringTurn(this.messages);
		return false;
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
		const senderId = message.sender.agentId;
		if (!this._multiAgentStore || !senderId) return;
		const data = buildDetachedToolCallCompletionEntry(this._multiAgentStore.getAgent(senderId));
		if (!data) return;
		const alreadyRecorded = this.sessionManager.getEntries().some((entry) => {
			if (entry.type !== "custom" || entry.customType !== DETACHED_TOOL_CALL_COMPLETION_CUSTOM_TYPE) return false;
			const existing = entry.data;
			return (
				typeof existing === "object" &&
				existing !== null &&
				"agentId" in existing &&
				existing.agentId === data.agentId &&
				"toolCallId" in existing &&
				existing.toolCallId === data.toolCallId
			);
		});
		if (!alreadyRecorded) this.sessionManager.appendCustomEntry(DETACHED_TOOL_CALL_COMPLETION_CUSTOM_TYPE, data);
	}

	private async _interceptRuntimeMailboxMessage(message: RuntimeMailboxMessage): Promise<boolean> {
		if (!this._extensionRunner.hasHandlers("runtime_mailbox")) return false;
		try {
			const result = await this._extensionRunner.emitRuntimeMailbox({ type: "runtime_mailbox", message });
			if (!result.handled) return false;
			this._markStoreMailboxMessageDelivered(message);
			return true;
		} catch (error) {
			this._failStoreMailboxDelivery(message, error);
			return true;
		}
	}

	private async _drainSharedChannelMessages(options: { triggerIfIdle: boolean }): Promise<boolean> {
		if (this._disableRuntimeCoordinationInbound || this._getRuntimeMailboxAgentId() !== null) {
			return false;
		}
		if (this._sharedChannelDrainInProgress) {
			return false;
		}
		if (options.triggerIfIdle && this.isStreaming) {
			return false;
		}
		const controlDbPath = this._getRuntimeMailboxControlDbPath();
		if (!controlDbPath) {
			return false;
		}
		this._sharedChannelDrainInProgress = true;
		try {
			return await this._drainSharedChannelMessagesFromDb(controlDbPath, options);
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
		if (!messageSnapshot) {
			return false;
		}
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
			const queued = await this._sendSharedChannelPrompt(prompt, options);
			advanceSharedChannelCursor(controlDbPath, recipient, lastMessageId);
			return queued;
		} catch (error) {
			if (isSessionBusyPromptError(error)) {
				return false;
			}
			throw error;
		}
	}

	private _sharedChannelRecipient(): RuntimeMailboxAddress {
		return {
			agentId: this._getRuntimeMailboxAgentId(),
			sessionId: this.sessionId,
		};
	}

	private async _sendSharedChannelPrompt(prompt: string, options: { triggerIfIdle: boolean }): Promise<boolean> {
		if (options.triggerIfIdle && !this.isStreaming) {
			await this.prompt(prompt, {
				expandPromptTemplates: false,
				source: "extension",
				streamingBehavior: "followUp",
			});
			return false;
		}
		await this._queueFollowUp(prompt, undefined, "extension");
		return true;
	}

	// The readiness transaction already committed canonical delivery; this updates the live projection.
	private _markStoreMailboxMessageDelivered(message: RuntimeMailboxMessage): string | undefined {
		const storeRef = message.storeRef;
		if (!storeRef) {
			return undefined;
		}
		if (this._multiAgentStore?.getPersistenceTarget()?.sessionPath === storeRef.sessionPath) {
			if (message.kind === "steer") {
				return this._markStoreSteeringDelivered(message, storeRef.messageId);
			}
			this._multiAgentStore.markMailboxMessageDelivered(storeRef.messageId);
			return undefined;
		}
		if (message.kind !== "steer") {
			const controlDbPath = this._getRuntimeMailboxControlDbPath();
			if (controlDbPath) {
				markMultiAgentMailboxMessageDelivered(controlDbPath, storeRef.sessionPath, storeRef.messageId);
			}
		}
		return undefined;
	}

	private _markStoreSteeringDelivered(message: RuntimeMailboxMessage, messageId: string): string | undefined {
		const agentId = message.recipient.agentId;
		if (!agentId || !this._multiAgentStore) {
			return undefined;
		}
		const current = this._multiAgentStore.getAgent(agentId);
		if (!current) {
			return undefined;
		}
		const persistence = this._multiAgentStore.getPersistenceTarget();
		if (!persistence) return undefined;
		const ownership = readMultiAgentRuntimeOwnership(persistence.controlDbPath, persistence.sessionPath, agentId);
		if (!ownership) return undefined;
		const coordinator = new LifecycleCoordinator({
			controlDbPath: persistence.controlDbPath,
			createAgentId: () => this._multiAgentStore?.allocateAgentIdForLifecycleCoordinator() ?? "",
			now: () => new Date().toISOString(),
			processIdentity: this._detachedJobProcessIdentity,
			sessionPath: persistence.sessionPath,
		});
		const delivered = coordinator.acknowledgeSteeringDelivery({ agent: current, messageId, ownership });
		if (!delivered.ok) return undefined;
		this._multiAgentStore.publishLifecycleCoordinatorSteeringDelivery(delivered.agent, delivered.message);
		this._runtimeMailboxSteeringAgentIds.add(agentId);
		return agentId;
	}

	private _failStoreMailboxDelivery(message: RuntimeMailboxMessage, error: unknown): void {
		const storeRef = message.storeRef;
		if (!storeRef) return;
		const failure = errorMessage(error);
		if (this._multiAgentStore?.getPersistenceTarget()?.sessionPath === storeRef.sessionPath) {
			this._multiAgentStore.markMailboxMessageFailed(storeRef.messageId, failure);
		} else {
			const controlDbPath = this._getRuntimeMailboxControlDbPath();
			if (controlDbPath) {
				markMultiAgentMailboxMessageFailed(controlDbPath, storeRef.sessionPath, storeRef.messageId, failure);
			}
		}
		if (message.kind !== "steer") return;
		const agentId = message.recipient.agentId;
		if (!agentId || !this._multiAgentStore) return;
		this._runtimeMailboxSteeringAgentIds.delete(agentId);
		const current = this._multiAgentStore.getAgent(agentId);
		if (current && !this._isTerminalMultiAgentLifecycle(current.lifecycle)) {
			this._finalizeReservedMultiAgent(current, "failed", { error: { message: failure } });
		}
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
		if (agentId) {
			registerRuntimeMailboxListener(controlDbPath, { agentId, sessionId: this.sessionId }, process.pid);
			return;
		}
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: this.sessionId },
			process.pid,
			this.sessionFile,
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
		const controlDbPath = this._getRuntimeMailboxControlDbPath();
		if (!controlDbPath) return;
		const agentId = this._getRuntimeMailboxAgentId();
		retireRuntimeMailboxListener(controlDbPath, { agentId, sessionId: this.sessionId }, process.pid);
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
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
		} else if (this.isStreaming) {
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

				const run = this._runAgentPrompt(appMessage);
				release();
				await run;
			});
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
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
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
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
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort the current operation, then submit preserved user input. A background
	 * turn may start after abort becomes idle, so the replacement prompt queues as
	 * steering instead of failing or losing the user's text.
	 */
	async interrupt(message: string, source: InputSource = "interactive"): Promise<void> {
		const trimmedMessage = message.trim();
		if (!trimmedMessage) {
			await this.abort();
			return;
		}
		const releasePendingInput = this.reserveExternalUserInput();
		try {
			await this.abort();
			await this.prompt(trimmedMessage, {
				preflightResult: (accepted) => {
					if (accepted) releasePendingInput();
				},
				source,
				streamingBehavior: "steer",
			});
		} finally {
			releasePendingInput();
		}
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
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

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore" | "fallback",
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
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
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
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

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

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
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

	/**
	 * Check if current model supports thinking/reasoning.
	 */
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

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
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
		return this._withTurnStartLock(() => this._compact(customInstructions));
	}

	private async _compact(customInstructions?: string): Promise<CompactionResult> {
		const wasRunningAgentTurn = this.isStreaming;
		this._disconnectFromAgent();
		await this.abort();
		const compactionAbortController = new AbortController();
		this._compactionAbortController = compactionAbortController;
		const sourceHint = await this.getCompactionSourceHint("manual", false);
		this._emit({ type: "compaction_start", reason: "manual", sourceHint });
		const startedAt = Date.now();

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
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry,
			});
			if (willRetry) {
				this._reconnectToAgent();
				await this._continueAfterManualCompaction(wasRunningAgentTurn, true);
			}
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
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
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact. Auto-resumes once when the turn was
	 *    "length"-truncated (unfinished work); otherwise NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param postRunCheck True when called after agent_end; false for the pre-prompt check.
	 *   Pre-prompt checks include aborted messages and never resume a truncated turn. Default: true
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
		const sameModel = model && assistantMessage.provider === model.provider && assistantMessage.model === model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

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
				if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
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
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
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
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		continueAfterCompaction = willRetry,
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		let started = false;
		let autoCompactionAbortController: AbortController | undefined;

		try {
			if (!this.model) {
				return false;
			}

			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			let env: Record<string, string> | undefined;
			if (settings.enabled) {
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

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			const sourceHint = await this.getCompactionSourceHint(reason, willRetry);
			this._emit({ type: "compaction_start", reason, sourceHint });
			autoCompactionAbortController = new AbortController();
			this._autoCompactionAbortController = autoCompactionAbortController;
			started = true;
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

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("compaction")) {
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
			if (started) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						reason === "overflow"
							? `Context overflow recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
				});
			}
			return false;
		} finally {
			if (this._autoCompactionAbortController === autoCompactionAbortController) {
				this._autoCompactionAbortController = undefined;
			}
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
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

		this._applyExtensionBindings(this._extensionRunner);
		await waitForHeadlessSessionStartRelease();
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
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
		runner.bindCommandContext(this._extensionCommandContextActions);

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

	private _createInternalCommands(): ReadonlyMap<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void>
	> {
		return new Map([
			[
				"model",
				async (args: string, ctx: ExtensionCommandContext) => {
					const modelReference = args.trim();
					if (!modelReference) return;
					const scopedModels = ctx.getScopedModels?.() ?? [];
					const models =
						scopedModels.length > 0
							? scopedModels.map((scoped) => scoped.model)
							: ctx.modelRegistry.getAvailable();
					const model = findExactModelReferenceMatch(modelReference, models);
					if (!model) throw new Error(`Model not found or not authenticated: ${modelReference}`);
					if (!(await ctx.setModel(model))) {
						throw new Error(`No API key for ${model.provider}/${model.id}`);
					}
				},
			],
		]);
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
				getModel: () => this.model,
				getThinkingLevel: () => this.thinkingLevel,
				getScopedModels: () => this.scopedModels,
				getFooterData: () => this._extensionFooterData,
				isIdle: () => !this.isStreaming,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.hasPendingMessages(),
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				restart: (options) => {
					if (!this._extensionCommandContextActions) {
						throw new Error("Restart is not available in this session mode");
					}
					return this._extensionCommandContextActions.restart(options);
				},
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
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

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
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
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
			this._createInternalCommands(),
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

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
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
		return isRetryableAssistantError(message);
	}

	private _findQuotaFallbackModel(message: AssistantMessage): Model<any> | undefined {
		if (this._quotaFallbackAttempted || message.stopReason !== "error" || !message.errorMessage) {
			return undefined;
		}
		if (!QUOTA_EXHAUSTION_PATTERN.test(message.errorMessage)) {
			return undefined;
		}

		const currentModel = this.model;
		if (!currentModel || message.provider !== currentModel.provider || message.model !== currentModel.id) {
			return undefined;
		}
		const pairedProvider = CODEX_PROVIDER_PAIRS.get(message.provider);
		if (!pairedProvider) {
			return undefined;
		}

		const fallbackModel = this._modelRegistry.find(pairedProvider, message.model);
		return fallbackModel && this._modelRegistry.hasConfiguredAuth(fallbackModel) ? fallbackModel : undefined;
	}

	private async _prepareQuotaFallback(message: AssistantMessage): Promise<boolean> {
		const fallbackModel = this._findQuotaFallbackModel(message);
		if (!fallbackModel) {
			return false;
		}

		this._quotaFallbackAttempted = true;
		const messages = this.agent.state.messages;
		if (messages.at(-1)?.role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		const previousModel = this.model;
		this.agent.state.model = fallbackModel;
		this.sessionManager.appendModelChange(fallbackModel.provider, fallbackModel.id);
		await this._emitModelSelect(fallbackModel, previousModel, "fallback");
		return true;
	}

	/**
	 * Prepare a retryable error for continuation with a fixed delay.
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

		const delayMs = settings.baseDelayMs;

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with fixed delay (abortable)
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

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Surface a provider-internal retry or transport fallback as a session event. */
	notifyProviderRetry(retry: ProviderRetryEvent): void {
		this._emit({ type: "provider_stream_retry", retry });
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
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
		this._bashAbortController = new AbortController();

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
					signal: this._bashAbortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortController = undefined;
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

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bashAbortController?.abort();
	}

	detachRunningTool(): boolean {
		return this._toolDetachRegistry.detachRunning();
	}

	detachBashTool(): boolean {
		return this.detachRunningTool();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined;
	}

	get hasDetachableTool(): boolean {
		return this._toolDetachRegistry.hasRunning();
	}

	get hasDetachableBashTool(): boolean {
		return this.hasDetachableTool;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
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

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		const sessionFile = this.sessionFile;
		if (sessionFile) {
			setNamedSession(this._controlDbPath, sessionFile, name);
		}
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	clearSessionName(): void {
		const sessionFile = this.sessionFile;
		if (sessionFile) {
			removeNamedSession(this._controlDbPath, sessionFile);
		}
		this.sessionManager.appendSessionInfo("");
		this._emit({ type: "session_info_changed", name: undefined });
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

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
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
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
				const model = this.model!;
				const { apiKey, headers, env } = await this._getRequiredRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFn,
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
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
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

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
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

	/**
	 * Get session statistics.
	 */
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

		// After compaction, pre-compaction assistant usage reflects the old context size.
		// Until a post-compaction assistant reports provider usage, estimate the rebuilt
		// context from message content so the footer still tracks new text/image input.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				const tokens = estimateMessagesTokens(this.messages);
				return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
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
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
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
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
