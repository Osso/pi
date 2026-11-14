import { type EffortLevel, query, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type Tool,
} from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { deleteSession } from "cc-session-io";
import { type BranchSummaryResult, generateBranchSummary } from "../../../src/core/compaction/branch-summarization.ts";
import { compact } from "../../../src/core/compaction/compaction.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import { buildSessionContext } from "../../../src/core/session-manager.ts";
import { keyHint } from "../../../src/modes/interactive/components/keybinding-hints.ts";
import {
	configureAccountRuntime,
	emitAccountPreparationFailure,
	errorMessage,
	fetchAccountRetryProfiles,
	markStreamComplete,
	prepareProviderAccount,
	registerClaudeUsageListener,
	resetAccountProfiles,
} from "./account-runtime.ts";
import {
	type AskClaudeMode,
	askClaudeCallTags,
	askClaudeToolDescription,
	buildAskClaudeParams,
	resolveAskClaudeDefaults,
	resolveAskClaudeMode,
} from "./askclaude-schema.ts";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.ts";
import { recordAuthFailure, recordCredentialTrace } from "./auth-trace.ts";
import { resolveClaudeCodeExecutable } from "./bundled-runtime.ts";

import { type Config, claudeCodeSettings, loadConfig, markStartupNoticeShown } from "./config.ts";
import { PROVIDER_ID } from "./convert.ts";
import { debug, diagDump, makeCliDebugOptions, moduleInstanceId } from "./diagnostics.ts";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.ts";
import {
	CC_CHILD_ENV,
	extractUserPrompt,
	extractUserPromptBlocks,
	isolatedStreamFn,
	requireSessionCwd,
	resultErrorText,
	setIsolatedQueryImpl,
	setLongContextSettings,
} from "./isolated-summary.ts";
import { createToolServer } from "./mcp-server.ts";
import { applyLongContext, buildModels, claudeCodeModelId, type LongContextSettings, resolveModel } from "./models.ts";
import {
	collectPromptSkills,
	type PromptCapture,
	projectPromptCapture,
	sharedPromptCaptures,
} from "./prompt-capture.ts";
import { makePromptStream, type PromptStream, userMessage } from "./prompt-stream.ts";
import {
	abandonedQueries,
	CONTINUE_AFTER_REWRITE_PROMPT,
	closeActiveQueries,
	deliverToolResults,
	discardRewrittenQuery,
	drainForAbort,
	setLifecycleUI,
	steerBlocks,
} from "./query-lifecycle.ts";
import { ACCOUNTS_EXHAUSTED, activeQueryContexts, ctx, QueryContext } from "./query-state.ts";
import {
	armStaleContexts,
	extractAllToolResults,
	historyRewrittenBySession,
	markRebuildForSession,
	reinjectPriorCompactionFileOps,
	type SessionState,
	sessionStateFor,
	setSessionStateFor,
	setSessionUI,
	sharedSessions,
	sponsorMarkRebuildForSession,
	syncSharedSession,
} from "./session-mirror.ts";
import { ShapeTrace } from "./shape-trace.ts";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, renderSkillsBlock } from "./skills.ts";
import {
	claimCurrentPiStream,
	consumeQuery,
	finalizeCurrentStream,
	mapToolName,
	setStreamUI,
} from "./stream-events.ts";

let piUI: ExtensionUIContext | null = null;

// Pi owns context files on the provider path, so Claude Code must not load its
// own on top: otherwise project CLAUDE.md/AGENTS.md files arrive twice, and
// ~/.claude/CLAUDE.md — a user persona written for a harness that is not the
// one running — arrives at all, stamped "These instructions OVERRIDE any default
// behavior" and outranking Pi's own AGENTS.md.
//
// Excludes rather than settingSources: the source gate that suppresses CLAUDE.md
// is the same one that reads settings.json, where Bedrock/Vertex users keep
// `env` and `apiKeyHelper`. Patterns are matched with picomatch against absolute
// paths; the filename globs cover user, ancestor, project and .claude/ copies,
// while rules need their own. Managed/policy memory is not excludable by design.
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

// --- Constants ---

// Marks which bridge module instance owns the registered provider's stream fn.
// Full registration policy (first vs later instances, shared vs own registry):
// see the "--- Provider ---" block in activate() below.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

// Claude Code's own builtin tools, for the AskClaude path where CC really runs
// them. The provider enables only native WebSearch, not these tools.
// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
const MODELS = buildModels(getModels("anthropic"));
let providerSettings: NonNullable<Config["provider"]> = {};
let claudeExecutable: string | undefined;
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };
const quotaRetrySessions = new Set<string | null>();

async function resumeAfterAccountRecheck(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<void> {
	try {
		await fetchAccountRetryProfiles(model, options?.signal);
		if (options?.signal?.aborted) throw new Error("Claude account quota recheck cancelled");
		const resumed = streamClaudeAgentSdk(model, context, options, false);
		for await (const event of resumed) stream.push(event);
		markStreamComplete(stream);
		stream.end();
	} catch (error) {
		emitAccountPreparationFailure(stream, model, error, options?.signal?.aborted);
	}
}

function rejectQueryAccount(queryCtx: QueryContext, rejection: { resetsAt?: number }): boolean {
	const profile = queryCtx.accountProfile;
	if (!profile) return true;
	const next = profile.manager.reject(profile.name, rejection.resetsAt, Date.now() / 1000);
	// Exhaustion still ends this query; recorded tool results belong to the next fresh call.
	quotaRetrySessions.add(queryCtx.piSessionId);
	return next !== undefined;
}

function settleQueryAccount(
	queryCtx: QueryContext,
	sdkQuery: ReturnType<typeof query>,
	account: ReturnType<typeof prepareProviderAccount>,
	cancelled: boolean | undefined,
): void {
	const quotaFailure = queryCtx.quotaFailure;
	const shouldReject = !cancelled && !abandonedQueries.has(sdkQuery);
	if (shouldReject && quotaFailure) {
		const hasEligibleAccount = rejectQueryAccount(queryCtx, quotaFailure);
		if (!hasEligibleAccount && queryCtx.turnOutput) {
			queryCtx.turnOutput.errorMessage = ACCOUNTS_EXHAUSTED;
		}
	}
	if (account) recordCredentialTrace(account, "settled", "isolated");
	recordAuthFailure(account, queryCtx.turnOutput?.errorMessage);
}

function failQueryStartup(
	queryCtx: QueryContext,
	promptStream: PromptStream,
	account: ReturnType<typeof prepareProviderAccount>,
	error: unknown,
): void {
	if (account) recordCredentialTrace(account, "settled", "isolated");
	recordAuthFailure(account, errorMessage(error));
	promptStream.fail(new Error("Query startup failed"));
	queryCtx.promptStream = null;
	if (queryCtx.turnOutput) {
		queryCtx.turnOutput.stopReason = "error";
		queryCtx.turnOutput.errorMessage = errorMessage(error);
	}
	finalizeCurrentStream(queryCtx, "error");
}

/** The Pi request each claimed stream answers, so a quota-rejected query can be served again. */
const piRequests = new WeakMap<
	AssistantMessageEventStream,
	{ model: Model<Api>; context: Context; options?: SimpleStreamOptions }
>();

/** A subscription limit rejected this query before any output reached Pi, and the account
 *  rotation left an eligible account: answer the same Pi request on it. Pi then sees no
 *  failure, so it neither counts a retry nor waits out its backoff. */
function replayOnNextAccount(queryCtx: QueryContext): boolean {
	const stream = queryCtx.currentPiStream;
	const output = queryCtx.turnOutput;
	const request = stream ? piRequests.get(stream) : undefined;
	if (!stream || !output || !request || !queryCtx.quotaFailure || queryCtx.turnStarted) return false;
	if (output.stopReason !== "error" || output.errorMessage === ACCOUNTS_EXHAUSTED) return false;
	debug(`provider: quota rejection before output, serving the request on the next account`);
	queryCtx.currentPiStream = null;
	void (async () => {
		try {
			for await (const event of streamClaudeAgentSdk(request.model, request.context, request.options))
				stream.push(event);
			markStreamComplete(stream);
			stream.end();
		} catch (error) {
			emitAccountPreparationFailure(stream, request.model, error, request.options?.signal?.aborted);
		}
	})();
	return true;
}

// --- Error handling ---

// AskClaude mode presets — controls which CC tools are blocked per mode.
// Only block tools that can't work (no pi TUI for user interaction).
// Other CC tools (Agent, SendMessage, RemoteTrigger, Tasks, etc.) are intentionally not blocked.
const ASKCLAUDE_ALWAYS_BLOCKED = [
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"ToolSearch", // probes for blocked tools, wastes tokens
	"ScheduleWakeup", // no harness to fire wakeup from inside a delegated subagent
];
const MODE_DISALLOWED_TOOLS: Record<AskClaudeMode, string[]> = {
	full: ASKCLAUDE_ALWAYS_BLOCKED,
	read: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Write",
		"Edit",
		"Bash",
		"NotebookEdit",
		"EnterWorktree",
		"ExitWorktree",
		"CronCreate",
		"CronDelete",
		"TeamCreate",
		"TeamDelete",
	],
	none: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Read",
		"Write",
		"Edit",
		"Glob",
		"Grep",
		"Bash",
		"Agent",
		"NotebookEdit",
		"EnterWorktree",
		"ExitWorktree",
		"CronCreate",
		"CronDelete",
		"TeamCreate",
		"TeamDelete",
		"WebFetch",
		"WebSearch",
	],
};

// The SDK's query(), or a test double (see setQuery). The compact/summary
// path calls the real query() directly — its subprocess must never be swapped
// out from under a real compaction.
let queryImpl: typeof query = query;
let askClaudeQueryImpl: typeof query = query;

// @internal
export const __test = {
	setQuery(fn: typeof query | null) {
		queryImpl = fn ?? query;
	},
	setIsolatedQuery(fn: typeof query | null) {
		setIsolatedQueryImpl(fn);
	},
	setAskClaudeQuery(fn: typeof query | null) {
		askClaudeQueryImpl = fn ?? query;
	},
	resetAccountProfiles() {
		resetAccountProfiles();
		quotaRetrySessions.clear();
	},
	resetSharedSession(piSessionId?: string | null) {
		// No id: full reset (the pre-map semantics — tests start from a blank slate).
		if (piSessionId === undefined) {
			sharedSessions.clear();
			pendingToolFailures.clear();
		} else {
			setSessionStateFor(piSessionId, null);
			pendingToolFailures.delete(piSessionId);
		}
		historyRewrittenBySession.clear();
	},
	markRebuildForSession,
	getHistoryRewritten: () => historyRewrittenBySession.size > 0,
	historyRewrittenBySession,
	armStaleContexts,
	discardRewrittenQuery,
	contextForToolResults,
	isQueryAbandoned: (q: object) => abandonedQueries.has(q),
	get activeQueryContexts() {
		return activeQueryContexts;
	},
	setSharedSession(piSessionId: string | null, state: SessionState | null) {
		setSessionStateFor(piSessionId, state);
	},
	getSharedSession(piSessionId: string | null = null) {
		return sessionStateFor(piSessionId);
	},
	setPiUI(ui: ExtensionUIContext | null) {
		piUI = ui;
		setSessionUI(ui);
		setStreamUI(ui);
		setLifecycleUI(ui);
	},
	syncSharedSession,
	extractUserPromptBlocks,
	consumeQuery,
	finalizeCurrentStream,
	resultErrorText,
	deliverToolResults,
	drainForAbort,
	CC_CHILD_ENV,
	buildMcpServers,
	branchSummaryOutcome,
	get promptCaptures() {
		return promptCaptures;
	},
};

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Global (not query state):
let piMode: ExtensionContext["mode"] | null = null;
// The SDK may fail while Pi executes a tool and no response stream is attached.
// Keep the failure until that session returns the tool result, not the dead query.
const pendingToolFailures = new Map<string | null, { toolCallIds: string[]; errorMessage: string }>();

function retainPendingToolFailure(c: QueryContext): void {
	if (c.currentPiStream || c.turnOutput?.stopReason !== "error" || c.turnToolCallIds.length === 0) return;
	pendingToolFailures.set(c.piSessionId, {
		toolCallIds: [...c.turnToolCallIds],
		errorMessage: c.turnOutput.errorMessage ?? "Claude query failed while a tool was running",
	});
}

// Defaults that silently cost the user something (no Opus 1M on Max, no
// AskClaude tool) are announced once. Deferred to the first bridge query rather
// than session_start: the notice persists a flag to the global config, and
// firing it on startup would write that file for every pi session that merely
// has this extension installed. One message, because consecutive info notifies
// overwrite each other in the TUI.
let pendingNotices: string[] = [];

function showStartupNoticeOnce(): void {
	// `hasUI` is true in RPC mode too — it means dialogs are possible, not that a
	// human is watching. Only a terminal user can act on this.
	if (pendingNotices.length === 0 || piMode !== "tui") return;
	const notices = pendingNotices;
	pendingNotices = [];
	const path = markStartupNoticeShown();
	// pi wraps the whole notify string in the theme's dim foreground; the inner reset
	// drops back to the terminal default rather than dim, which is fine here.
	const title = `\x1b[33mWelcome to pi-claude-bridge\x1b[39m — settings live in ${path}`;
	const bullets = [...notices, "This message only appears once. See README.md for more."].map((n) => `• ${n}`);
	piUI?.notify([title, ...bullets, "─".repeat(64)].join("\n"), "info");
}

// Captures of what pi assembled per agent; see src/prompt-capture.ts for why this
// is keyed rather than held in a single slot. One process-wide instance, shared
// across every extension module instance: isolated subagents re-evaluate this
// module, and the pinned stream they all route through resolves against it.
const promptCaptures = sharedPromptCaptures((diagnostic) => {
	const first = diagnostic.matches[0];
	debug(
		`prompt-capture: no match for ${diagnostic.systemPrompt.length}-char system prompt. ` +
			(first
				? `closest known (${first.key.length}-char) shares its first ${first.firstDivergent} chars and diverges at offset ${first.firstDivergent}: ` +
					JSON.stringify(diagnostic.systemPrompt.slice(first.firstDivergent - 40, first.firstDivergent + 60))
				: "no known captures to compare against.") +
			` known keys=${diagnostic.matches.length}`,
	);
});

/** Whatever a settled session left behind, named in one greppable line.
 *
 *  Every one of these should be empty once the last turn ends, and each is a leak
 *  that costs something real: a retained context routes a later orphaned tool result
 *  into the delivery path and returns a stream nobody ends; a pending tool call is an
 *  MCP handler Claude Code is still waiting on; a live prompt stream is an unresolved
 *  ack. The activeQueryContexts leak was present on every single happy-path run and
 *  no test noticed, because nothing asserted that anything ends clean — so assert it
 *  where the real sessions are, and let diag/audit-warnings.mjs scan for it. */
function reportLeaks(label: string): void {
	const pendingCalls = [...activeQueryContexts].reduce((n, c) => n + c.pendingToolCalls.size, 0);
	const liveStreams = [...activeQueryContexts].filter((c) => c.promptStream !== null).length;
	if (activeQueryContexts.size === 0 && pendingCalls === 0 && liveStreams === 0) return;
	debug(
		`WARNING: ${label} left state behind — contexts=${activeQueryContexts.size} ` +
			`pendingToolCalls=${pendingCalls} promptStreams=${liveStreams}`,
	);
}

/** What pi's branch summary means for the navigation it was asked for.
 *
 *  Cancelling on failure matches pi's own path, which rethrows a summary error out
 *  of the navigation rather than moving without one. Separated from the event
 *  handler so this decision is testable without a Claude Code subprocess — driving
 *  `generateBranchSummary` itself would only be testing pi. */
function branchSummaryOutcome(
	result: BranchSummaryResult,
): { cancel: true } | { summary: { summary: string; details: unknown } } {
	if (result.aborted) return { cancel: true };
	if (result.error) throw new Error(result.error);
	debug(`session_before_tree: takeover complete summaryLen=${result.summary?.length ?? 0}`);
	return {
		summary: {
			summary: result.summary ?? "",
			details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] },
		},
	};
}

function contextForToolResults(results: McpResult[]): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (
				queryCtx.pendingToolCalls.has(id) ||
				queryCtx.pendingResults.has(id) ||
				queryCtx.turnToolCallIds.includes(id)
			) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

function resolveMcpTools(
	context: Context,
	excludeToolName?: string,
): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName || tool.name === "web_search") continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers receive their toolCallId from Claude's tools/call _meta, so results
// are matched by ID end to end.
//
// The handler and pi's result can arrive in either order, hence the two maps:
// a result that lands first waits in `pendingResults` for the handler to claim
// it, and a handler that runs first parks its resolver in `pendingToolCalls`.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
function buildMcpServers(
	tools: Tool[],
	queryCtx: QueryContext,
): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		handler: async (toolCallId: string) => {
			const queuedResult = queryCtx.pendingResults.get(toolCallId);
			if (queuedResult !== undefined) {
				queryCtx.pendingResults.delete(toolCallId);
				debug(
					`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`,
				);
				return queuedResult;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
			});
		},
	}));
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
};

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

// --- Provider helpers: misc ---

/** pi ended its run on a tool call (end_turn or another terminating tool), so it will never make
 *  the provider call that answers it. Answer it here with pi's recorded result and let the
 *  PostToolBatch hook stop CC before another model request. Otherwise the next prompt would answer
 *  it instead, with the new user message attached as a mid-turn steer the model treats as an aside.
 *  Awaited at agent_end, which pi awaits before starting the next prompt. */
async function closeEndedTurn(piSessionId: string | null, runMessages: Context["messages"]): Promise<void> {
	const lastAssistant = [...runMessages].reverse().find((message) => message.role === "assistant");
	if ((lastAssistant as AssistantMessage | undefined)?.stopReason !== "toolUse") return;
	const { results } = _extractAllToolResults(
		runMessages as unknown as Array<{ role: string; [key: string]: unknown }>,
	);
	const c = contextForToolResults(results);
	if (!c || c.piSessionId !== piSessionId || !c.activeQuery) return;
	c.turnEnded = true;
	// The ended turn's tool call and results are now in CC's session; the next prompt resumes past them.
	c.latestCursor += 1 + results.length;
	debug(`provider: pi run ended on ${results.length} tool result(s); closing the CC turn`);
	await deliverToolResults(c, results, null, c.latestCursor);
	await c.settled?.catch(() => {});
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamClaudeAgentSdk(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	allowQuotaRecheck = true,
): AssistantMessageEventStream {
	showStartupNoticeOnce();
	// One-off summarizer calls arrive HERE too, not only via isolatedStreamFn: /bug report
	// (summarizeForBugReport) routes through agent.streamFunction -> streamSimple, with no
	// takeover hook. pi marks every one-off summarizer with cacheRetention:"none" in
	// completeSummarization, so route on the marker: their prompt is never recorded by the
	// capture boundaries and resolveOrDerive would throw. Hand them to the isolated path
	// (separate persistSession:false CC process, no session sync needed).
	if (options?.cacheRetention === "none") {
		debug(
			`provider: one-off summarizer call (cacheRetention none) routed to isolated summary, msgs=${context.messages.length}`,
		);
		return isolatedStreamFn(model, context, options);
	}

	const stream = createAssistantMessageEventStream();
	const piSession = options?.sessionId ?? null;
	const quotaRetry = quotaRetrySessions.has(piSession);

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(
		`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`,
	);

	let activeQuery = ctx().activeQuery !== null;
	const allResults = extractAllToolResults(context);
	const pendingFailure = pendingToolFailures.get(piSession);
	const hasPendingFailureResult = allResults.some(
		(result) => result.toolCallId !== undefined && pendingFailure?.toolCallIds.includes(result.toolCallId),
	);
	if (pendingFailure && hasPendingFailureResult) {
		pendingToolFailures.delete(piSession);
		const failed = new QueryContext();
		failed.resetTurnState(model);
		const output = failed.turnOutput;
		if (!output) throw new Error("Failed to initialize deferred Claude error response");
		output.stopReason = "error";
		output.errorMessage = pendingFailure.errorMessage;
		claimCurrentPiStream(stream, "late-tool-error", failed);
		queueMicrotask(() => finalizeCurrentStream(failed, "error"));
		return stream;
	}
	let resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
	// Pi can retry as soon as the error stream ends, before the old query's
	// final cleanup removes its tool ids. Those results belong to a fresh query.
	if (quotaRetry && resultCtx?.turnOutput?.stopReason === "error") resultCtx = undefined;

	// pi rewrote its history while this query sat parked at a tool boundary, so the
	// query answers about a conversation that no longer exists. Discard it and let
	// this tool result carry the turn into a fresh query over the rewritten history.
	// The staleness mark is per pi session: a subagent's compaction (its own
	// AgentSession, sharing this process) must not discard the parent's parked
	// query, and vice versa.
	const rewrittenUnderQuery = Boolean(resultCtx?.historyStale);
	if (resultCtx && rewrittenUnderQuery) {
		discardRewrittenQuery(resultCtx);
		resultCtx = undefined;
		// Recomputed, not cleared: a reentrant subagent may still hold a query of its own.
		activeQuery = ctx().activeQuery !== null;
	}

	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(
			`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`,
		);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx);
		piRequests.set(stream, { model, context, options });
		resultCtx.resetTurnState(model);
		// A rewrite that armed the mark after this query parked gets copied here,
		// though markRebuildForSession usually reaches it directly.
		if (!resultCtx.historyStale && resultCtx.piSessionId && historyRewrittenBySession.has(resultCtx.piSessionId)) {
			resultCtx.historyStale = true;
		}
		// User messages (steer/followUp) pi injected into context during the
		// active query: a steer sent while a tool was executing, drained by pi at
		// the turn boundary and appended alongside the tool result.
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		// Delivery is async because the steer must reach CC's stdin *before* the
		// tool result does — see deliverToolResults. Detached so the provider
		// still returns its stream synchronously.
		void deliverToolResults(resultCtx, allResults, steer, context.messages.length);
		// The shared cursor tracks the top-level conversation. A reentrant subagent
		// delivering its own results would drag it to that subagent's message count
		// — observed pulling a parent from 5 back to 3, which cost the parent's next
		// turn a full rebuild and a flushed prompt cache.
		const state = sessionStateFor(resultCtx.piSessionId);
		if (state) state.cursor = context.messages.length;
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message. The discard
	// branch above already siphoned off the stale-query case, which goes on to a
	// rebuild instead — that one has somewhere to deliver the result to.
	const lastMsg = context.messages[context.messages.length - 1];
	const previousAssistant = [...context.messages].reverse().find((message) => message.role === "assistant") as
		| AssistantMessage
		| undefined;
	const continuingOtherProvider =
		lastMsg?.role === "toolResult" &&
		previousAssistant !== undefined &&
		previousAssistant.provider !== model.provider;
	if (lastMsg?.role === "toolResult" && !rewrittenUnderQuery && !quotaRetry && !continuingOtherProvider) {
		diagDump("orphaned_tool_result", {
			piSessionId: piSession,
			toolCallIds: allResults.map((result) => result.toolCallId),
			activeSessions: [...activeQueryContexts].map((c) => ({
				piSessionId: c.piSessionId,
				toolCallIds: c.turnToolCallIds,
			})),
		});
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		// With no query in flight anywhere, the top-level session this result
		// belongs to is the one whose turn just ended: its cursor advances to
		// count the result (options.sessionId is that session — pi emits the
		// result event through the same session's streamSimple call).
		const orphanState = sessionStateFor(options?.sessionId ?? null);
		if (orphanState && activeQueryContexts.size === 0) orphanState.cursor = context.messages.length;
		// No query owns this result, so there is no context to reset: resetTurnState
		// on the top-level ctx() would replace a live parent's turnOutput mid-stream,
		// stranding the blocks it had already emitted. A throwaway context just
		// supplies the empty message this turn ends with.
		const c = new QueryContext();
		c.resetTurnState(model);
		const output = c.turnOutput;
		if (!output) throw new Error("Failed to initialize orphaned tool-result response");
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: output });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---
	pendingToolFailures.delete(piSession);

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query.
	const isReentrant = activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	// Resolved first: an unaccountable system prompt fails this query before anything
	// is claimed or reset, leaving no half-built query behind — in particular no stream
	// claimed on the shared context that nobody will ever end.
	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, askClaudeToolName);
	// Build from what Pi loaded for this run, so `--no-context-files` and
	// `--no-skills` reach Claude Code by leaving nothing to forward. A sub-agent's
	// custom override embeds its parent's assembled Pi prompt; recursive projection
	// replaces that exact inherited prompt with its already-safe portable parts.
	// Derive the key from the context Pi passed to this provider, not from recorded keys.
	let promptCapture: PromptCapture | undefined;
	let systemPromptAppend: string | undefined;
	let account: ReturnType<typeof prepareProviderAccount>;
	try {
		account = prepareProviderAccount();
	} catch (error) {
		if (allowQuotaRecheck && error instanceof Error && error.message === ACCOUNTS_EXHAUSTED) {
			void resumeAfterAccountRecheck(stream, model, context, options);
		} else {
			emitAccountPreparationFailure(stream, model, error);
		}
		return stream;
	}
	try {
		promptCapture = promptCaptures.resolveOrDerive(context.systemPrompt);
		systemPromptAppend = promptCapture
			? projectPromptCapture(promptCapture, {
					skillReadTool: mcpTools.some((tool) => tool.name === "read") ? "mcp" : "none",
				})
			: undefined;
	} catch (err) {
		// resolveOrDerive and projectPromptCapture throw to stop a turn that would lose
		// its instructions or leak pi's harness text. Report it on the stream, as pi-ai's
		// provider contract expects, so any caller — not only pi's agent loop, which
		// catches a throw — sees a failed turn rather than a synchronous exception.
		emitAccountPreparationFailure(stream, model, err);
		diagDump("prompt_capture_unresolved", {
			promptChars: context.systemPrompt?.length ?? 0,
			knownKeys: promptCaptures.size,
			reentrantUserQuery: isReentrantUserQuery,
			error: errorMessage(err),
		});
		return stream;
	}

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	piRequests.set(stream, { model, context, options });
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	// Stale ids would let a late result from the previous query route here via
	// contextForToolResults — which now means pushing its steer into this
	// query's stdin, not just mismatching a map.
	queryCtx.turnToolCallIds = [];
	queryCtx.resetTurnState(model);
	// The prompt's own history, so closeEndedTurn can count the ended turn's messages on top.
	queryCtx.latestCursor = context.messages.length;
	queryCtx.turnEnded = false;
	// The served pi session, for rewrite attribution on delivery (issue #101
	// follow-up) and on SessionState. A fresh instance of this module inside a
	// worktree-spawned subagent has its own contexts; each records its own.
	queryCtx.piSessionId = options?.sessionId ?? null;
	queryCtx.shapeTrace = providerSettings.shapeTrace === true ? new ShapeTrace(queryCtx.piSessionId) : undefined;
	// A discarded query's replacement reuses this context; without the reset its
	// first tool result would sit on armed staleness again (the mark is consumed
	// from the set, not from here) and re-discard a healthy query.
	queryCtx.historyStale = false;
	queryCtx.missedSteer = false;
	queryCtx.rateLimitRejection = null;
	queryCtx.quotaFailure = null;
	queryCtx.accountProfile = account ? { name: account.name, manager: account.manager } : null;
	quotaRetrySessions.delete(queryCtx.piSessionId);

	const cwd = requireSessionCwd(options);
	// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
	// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
	const cliModel = claudeCodeModelId(model, longContextSettings);
	// Which pi session this query serves — the attribution key for history
	// rewrites (session_compact / session_tree) and for SessionState above.
	const piSessionId = options?.sessionId ?? null;
	const syncResult = syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel, piSessionId);
	// This query starts from the history pi has now: consume this session's
	// armed rewrite — a sibling pi session's stays armed for its own queries.
	if (piSessionId) historyRewrittenBySession.delete(piSessionId);
	const { sessionId: resumeSessionId } = syncResult;
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// A turn continuing past a discarded query ends at its tool result, not at a
	// prompt, so say what happened rather than falling into the empty-prompt
	// recovery below — that one is for a shape we do not expect, and this is one
	// we do. The rebuilt session already ends with the tool result, placed after
	// the tool call it answers.
	if ((rewrittenUnderQuery || quotaRetry) && !promptText && !promptBlocks) {
		promptText = CONTINUE_AFTER_REWRITE_PROMPT;
		debug(`provider: continuing the turn after a rewritten history, ${context.messages.length} msgs rebuilt`);
	}

	if (continuingOtherProvider && !promptText && !promptBlocks) {
		promptText = "[Continue the user's task from the completed tool results above.]";
	}

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		const sessionState = sessionStateFor(piSessionId);
		const defaultSessionState = sessionStateFor(null);
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: sessionState
				? {
						sessionId: sessionState.sessionId.slice(0, 8),
						cursor: sessionState.cursor,
					}
				: defaultSessionState
					? { sessionId: defaultSessionState.sessionId.slice(0, 8), cursor: defaultSessionState.cursor }
					: null,
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	// Always stream the prompt rather than passing a string: a parked input
	// generator is what lets us write steers to CC's stdin mid-turn. The cost is
	// that `isSingleUserTurn` is false, so the SDK no longer closes stdin on the
	// first result — consumeQuery ends the stream explicitly instead, or the
	// query would never terminate.
	const promptStream = makePromptStream();
	void promptStream
		.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
		.catch((error) => debug(`provider: initial prompt push rejected:`, error));
	queryCtx.promptStream = promptStream;
	const mcpServers = buildMcpServers(mcpTools, queryCtx);

	// MCP auto-loading suppression: CC reads MCP servers from ~/.claude.json (top-level
	// + per-project) and .mcp.json. Since pi executes tools (not CC), those are pure
	// token overhead. --strict-mcp-config tells the binary to use ONLY mcpServers passed
	// programmatically and ignore filesystem MCP entries — applied unconditionally because
	// settingSources is left at CC's default, which loads all sources.
	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;

	// Prefer the model's own thinkingLevelMap (per-model overrides — e.g. a map can
	// route xhigh→xhigh where the generic table maps xhigh→max). pi-ai's catalog
	// ships a map for most Claude models; the table below covers models without
	// one, and the levels a map leaves unnamed. A null entry means the level is
	// unsupported on that model: no effort argument is sent, so Claude Code's own
	// default applies rather than the generic table's value. Map values are
	// provider-generic strings, so a map value is trusted only when it names a
	// level CC accepts.
	const mapped = options?.reasoning ? model.thinkingLevelMap?.[options.reasoning] : undefined;
	const effort = options?.reasoning
		? mapped === undefined
			? REASONING_TO_EFFORT[options.reasoning]
			: VALID_EFFORTS.has(mapped as EffortLevel)
				? (mapped as EffortLevel)
				: undefined
		: undefined;

	const extraArgs: Record<string, string | null> = { model: cliModel };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
	if (effort) extraArgs["thinking-display"] = "summarized";

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources=undefined.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see handler in default export). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
	// threshold with CC's, including CC's anti-thrashing guard (issue #8).
	// Manual /compact in CC still works (we never invoke it).
	const childEnv = {
		...process.env,
		...CC_CHILD_ENV,
		...(account ? { CLAUDE_CONFIG_DIR: account.configDir } : {}),
	};
	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		env: childEnv,
		tools: ["WebSearch"],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		// includeGitInstructions:false drops the gitStatus block from the preset.
		// That block is the trailing suffix of the cached system block, and a
		// git-state transition (new file, staging, commit) rewrites it — busting
		// the prompt cache for the whole conversation from there on (see
		// diag/probe-git-cache.mjs). The bridge re-invokes CC per turn, so this
		// hit on every transition. Cost here is nil: the setting also strips
		// CC's git-workflow guidance from its Bash tool prompt, but the provider
		// path enables only native WebSearch, so Bash's definitions never ship.
		// AskClaude keeps CC's native tools and its guidance — unaffected.
		settings: {
			...claudeCodeSettings(providerSettings),
			claudeMdExcludes: CLAUDE_MD_EXCLUDES,
			includeGitInstructions: false,
		},
		systemPrompt: {
			type: "preset",
			preset: "claude_code",
			append: systemPromptAppend ? systemPromptAppend : undefined,
		},
		extraArgs,
		// Ends CC's turn after the tool batch that ended pi's run, without another model
		// request (pinned by tests/int-cc-contracts.mjs). Other batches continue as usual.
		hooks: { PostToolBatch: [{ hooks: [async () => (queryCtx.turnEnded ? { continue: false } : {})] }] },
		...(effort ? { effort } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions("provider", account),
	};

	debug(
		"provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`,
	);

	// 3. Start SDK query and claim it for this context
	let wasAborted = false;
	let sdkQuery: ReturnType<typeof query>;
	try {
		sdkQuery = queryImpl({ prompt: promptStream.stream, options: queryOptions });
	} catch (error) {
		failQueryStartup(queryCtx, promptStream, account, error);
		return stream;
	}
	queryCtx.activeQuery = sdkQuery;
	activeQueryContexts.add(queryCtx);

	// 4. Capture context for abort handling
	const abortCtx = queryCtx;

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try {
			sdkQuery.close();
		} catch {}
	};
	const onAbort = () => {
		wasAborted = true;
		drainForAbort(abortCtx, promptStream);
		requestAbort();
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Background consumer — runs until query ends
	queryCtx.settled = consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
		.catch((error) => {
			if (!abandonedQueries.has(sdkQuery) && queryCtx.turnOutput) {
				queryCtx.turnOutput.stopReason = "error";
				queryCtx.turnOutput.errorMessage ??= errorMessage(error);
			}
			throw error;
		})
		.finally(() => settleQueryAccount(queryCtx, sdkQuery, account, wasAborted || options?.signal?.aborted))
		.then(async ({ capturedSessionId }) => {
			debug(
				`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`,
			);

			// Discarded out from under: the query continuing the turn owns the context,
			// the session and the stream. Capturing this one's session id here would put
			// Claude Code back on the conversation it was discarded for.
			if (abandonedQueries.has(sdkQuery)) {
				debug("provider: discarded query completed, leaving session and stream to its replacement");
				return;
			}

			// --- Abort detection in normal completion path ---
			if (wasAborted || options?.signal?.aborted) {
				// The killed subprocess may flush a late record into this session's
				// JSONL — its own mirror's next sync must rebuild and rotate.
				const state = sessionStateFor(queryCtx.piSessionId);
				if (state) setSessionStateFor(queryCtx.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
				debug(`provider: abort detected, marked sharedSession needsRebuild + forceRotate`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "aborted";
					queryCtx.turnOutput.errorMessage = "Operation aborted";
				}
				const stream = queryCtx.currentPiStream;
				if (stream && queryCtx.turnOutput) {
					stream.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput });
				}
				markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
				return;
			}

			// --- Capture session ID ---
			// This query's own mirror — a reentrant subagent completing does not
			// reassign the parent's conversation to the child's CC file.
			if (syncResult.preserveSharedSession) {
				const state = sessionStateFor(queryCtx.piSessionId);
				if (capturedSessionId && capturedSessionId !== state?.sessionId) {
					deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
					debug(
						`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`,
					);
				}
				debug(
					`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`,
				);
			} else {
				const state = sessionStateFor(queryCtx.piSessionId);
				const sessionId = capturedSessionId ?? state?.sessionId;
				if (sessionId) {
					const cursor = Math.max(context.messages.length, queryCtx.latestCursor, state?.cursor ?? 0);
					debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
					// A missed steer may precede the first mirror or arrive while this
					// query is still able to complete. Preserve both rebuild signals.
					setSessionStateFor(queryCtx.piSessionId, {
						...state,
						sessionId,
						cursor,
						cwd,
						needsRebuild: queryCtx.missedSteer || state?.needsRebuild,
					});
				}
			}

			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			if (replayOnNextAccount(queryCtx)) return;
			retainPendingToolFailure(queryCtx);
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		})
		.catch((error) => {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			if (abandonedQueries.has(sdkQuery)) {
				debug("provider: discarded query ended in error, leaving session and stream to its replacement");
				return;
			}
			if (wasAborted || options?.signal?.aborted) {
				const state = sessionStateFor(queryCtx.piSessionId);
				if (state) setSessionStateFor(queryCtx.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
			} else {
				// Drop this session's mirror: its conversation is in an unknown
				// state after the error. Other sessions' mirrors stay — one
				// session's failure says nothing about another's conversation.
				setSessionStateFor(queryCtx.piSessionId, null);
			}
			promptStream.fail(error instanceof Error ? error : new Error(String(error)));
			if (queryCtx.turnOutput) {
				queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
				// The SDK drops its copy of the result text if any message follows the error
				// result, so prefer the cause consumeQuery recorded off the result itself.
				queryCtx.turnOutput.errorMessage ??= error instanceof Error ? error.message : String(error);
			}
			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				queryCtx.releasePendingToolCalls("Query ended");
				debug("provider: clearing activeQuery before error stream completion");
				queryCtx.activeQuery = null;
			}
			// Claude Code exits non-zero after a quota error result, so the SDK throws here
			// rather than completing; the rejected request still belongs on the next account.
			if (!wasAborted && !options?.signal?.aborted && replayOnNextAccount(queryCtx)) return;
			retainPendingToolFailure(queryCtx);
			const stream = queryCtx.currentPiStream;
			if (stream && queryCtx.turnOutput) {
				stream.push({
					type: "error",
					reason: (queryCtx.turnOutput.stopReason ?? "error") as "aborted" | "error",
					error: queryCtx.turnOutput,
				});
			}
			markStreamComplete(stream);
			stream?.end();
			queryCtx.currentPiStream = null;
		})
		.finally(() => {
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			// Settle any ack still parked in the generator — the CLI is gone, so
			// nothing will resume it. Clear the handle only if a later query
			// hasn't already claimed the shared context.
			promptStream.fail(new Error("query ended"));
			if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
			// A later query claiming this context sets activeQuery to its own handle;
			// null means the .then/.catch above cleared ours and nothing replaced it.
			// Testing only for `=== sdkQuery` would never fire on the non-reentrant
			// path, leaving the top-level context in the routing set forever — where a
			// later orphaned tool result matches its stale turnToolCallIds and takes
			// the delivery branch, returning a stream nothing ends.
			if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
				queryCtx.releasePendingToolCalls("Query ended");
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
			}
			sdkQuery.close();
		});

	return stream;
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	cwd: string,
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string;
		appendSkills?: boolean;
		onStreamUpdate?: (responseText: string) => void;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
		/** pi session the calling tool ran in — AskClaude's conversation continues
		 *  the session that called it, so its sync and capture key that mirror. */
		piSessionId?: string | null;
	},
): Promise<{ responseText: string; stopReason: string }> {
	const requestedModel = options?.model ?? "opus";
	const model = resolveModel(MODELS, requestedModel);
	const modelId = model?.id ?? requestedModel;
	const account = prepareProviderAccount();
	const cliModel = model ? claudeCodeModelId(model, longContextSettings) : modelId;

	// Session resume for shared mode — reuse provider's session if it exists,
	// otherwise create one from pi's context.
	// Note: doesn't update the mirror's cursor after completion, so the next
	// provider call will see missed messages and trigger a Case 4 rebuild.
	// AskClaude has a random-origin context handed to it, but the session it
	// belongs to is the one whose tool ran — the extension API's execute ctx
	// carries it — passed here as piSessionId and used for every map access.
	const askClaudeSessionId = options?.piSessionId ?? null;
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.context?.length) {
		const askClaudeState = sessionStateFor(askClaudeSessionId);
		if (askClaudeState) {
			// Provider already has a session — just resume from it
			// Any missed messages from other providers were already handled by the provider's Case 4
			resumeSessionId = askClaudeState.sessionId;
		} else {
			// No provider session yet — create one from pi's context
			const contextWithPrompt = [
				...options.context,
				{ role: "user" as const, content: prompt, timestamp: Date.now() },
			];
			const sync = syncSharedSession(
				contextWithPrompt as Context["messages"],
				cwd,
				undefined,
				cliModel,
				askClaudeSessionId,
			);
			resumeSessionId = sync.sessionId;
		}
	}

	// Mode → disallowed tools
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode];

	// AskClaude uses Claude Code's native Read tool rather than Pi's MCP bridge.
	// Same resolver as the provider path: a prompt neither recorded nor derivable
	// throws here too, rather than silently sending Claude Code no skills.
	//
	// Resolved only when the answer would be used. The throw is justified by what a
	// miss would cost, so where it costs nothing — skills switched off, or no reader
	// to open a skill file with — an unrelated miss must not fail the call.
	const skillReadTool = disallowedTools.includes("Read") ? "none" : "native";
	const skillCapture =
		options?.appendSkills !== false && skillReadTool !== "none"
			? promptCaptures.resolveOrDerive(options?.systemPrompt)
			: undefined;
	const skillsBlock = skillCapture ? renderSkillsBlock(collectPromptSkills(skillCapture), skillReadTool) : undefined;

	// Effort
	const effort = options?.thinking && options.thinking !== "off" ? REASONING_TO_EFFORT[options.thinking] : undefined;

	const extraArgs: Record<string, string | null> = {
		"strict-mcp-config": null,
		model: cliModel,
	};
	if (effort) extraArgs["thinking-display"] = "summarized";

	debug(
		"askClaude:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
		`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`skills=${Boolean(skillsBlock)} promptLen=${prompt.length}`,
	);

	// skills: [] suppresses Claude Code's own skill listing, a system-reminder naming every
	// skill under the ~/.claude estate. The provider's native-tool allowlist excludes
	// Skill and its listing, but AskClaude runs on CC's native
	// tools, so it has to be asked for. Pi-side skills still arrive via skillsBlock below,
	// which is meant to be the only channel.
	const sdkQuery = askClaudeQueryImpl({
		prompt,
		options: {
			cwd,
			env: { ...process.env, ...CC_CHILD_ENV, ...(account ? { CLAUDE_CONFIG_DIR: account.configDir } : {}) },
			permissionMode: "bypassPermissions",
			settings: { ...claudeCodeSettings(providerSettings), claudeMdExcludes: CLAUDE_MD_EXCLUDES },
			skills: [],
			...(disallowedTools.length ? { disallowedTools } : {}),
			...(effort ? { effort } : {}),
			// Preset unconditionally: omitting it leaves the child on the SDK's bare default,
			// without the tool and permission guidance the bridge relies on everywhere else.
			// Whether pi has skills to append is unrelated to whether the child needs that.
			systemPrompt: { type: "preset", preset: "claude_code", append: skillsBlock },
			settingSources: ["user", "project"] as SettingSource[],
			extraArgs,
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			...(options?.isolated ? { persistSession: false } : {}),
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			...makeCliDebugOptions("askclaude", account),
		},
	});

	// Abort handling
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => {
			try {
				sdkQuery.close();
			} catch {}
		});
	};
	if (signal?.aborted) {
		onAbort();
		throw new Error("Aborted");
	}
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";
	let sdkMessageCount = 0;
	let textDeltaCount = 0;
	let resultSubtype: string | undefined;

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;
			sdkMessageCount++;

			switch (message.type) {
				case "stream_event": {
					const event = message.event;
					// Text deltas → accumulate and stream
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						responseText += event.delta.text;
						textDeltaCount++;
						options?.onStreamUpdate?.(responseText);
					}
					// Tool call start → track for action summary progress
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						debug(`askClaude: tool_use start: ${event.content_block.name}`);
						toolCalls.set(event.content_block.id, {
							name: mapToolName(event.content_block.name),
							status: "running",
						});
					}
					break;
				}
				case "assistant": {
					// Update tool calls with full input for action summary
					for (const block of message.message?.content ?? []) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, {
								name: mapToolName(block.name),
								status: "complete",
								rawInput:
									block.input && typeof block.input === "object" && !Array.isArray(block.input)
										? (block.input as Record<string, unknown>)
										: undefined,
							});
						}
					}
					break;
				}
				case "result": {
					resultSubtype = message.subtype;
					if (message.usage) {
						debug(
							`askClaude: result usage: in=${message.usage.input_tokens} out=${message.usage.output_tokens} cacheRead=${message.usage.cache_read_input_tokens ?? 0} cacheWrite=${message.usage.cache_creation_input_tokens ?? 0} turns=${message.num_turns ?? "?"}`,
						);
					}
					// Claude Code reports an API failure with `is_error` on a result whose
					// subtype is still "success", so without this the error text was returned
					// as Claude's answer and pi's model read a 429 as content. Throwing hands
					// it to the tool's own catch, which renders it as an error result.
					const failure = wasAborted ? undefined : resultErrorText(message);
					if (failure) throw new Error(failure);
					if (!responseText && message.subtype === "success" && message.result) {
						responseText = message.result;
					}
					break;
				}
			}
		}

		const stopReason = wasAborted ? "cancelled" : "stop";
		debug(
			`askClaude: done`,
			`stopReason=${stopReason} resultSubtype=${resultSubtype ?? "none"}`,
			`sdkMessages=${sdkMessageCount} textDeltas=${textDeltaCount} responseLen=${responseText.length}`,
			`toolCalls=${toolCalls.size}`,
		);
		return { responseText, stopReason };
	} catch (error) {
		recordAuthFailure(account, errorMessage(error));
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
	}
}

// --- Extension registration ---

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

let askClaudeToolName = "AskClaude";

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(pi.cwd);
	debug("loadConfig:", JSON.stringify(config));
	providerSettings = config.provider ?? {};
	claudeExecutable = resolveClaudeCodeExecutable(providerSettings.pathToClaudeCodeExecutable);
	configureAccountRuntime(providerSettings, claudeExecutable);
	registerClaudeUsageListener(pi);
	// We need these settings to know if we're eligible for 1M context on certain models
	// Validate at the boundary: a non-array here would throw inside every
	// claudeCodeModelId call and brick the extension at activation.
	const forceTwoHundredK = Array.isArray(providerSettings.forceTwoHundredK)
		? providerSettings.forceTwoHundredK.filter((id): id is string => typeof id === "string")
		: undefined;
	longContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
		forceTwoHundredK,
	};
	setLongContextSettings(longContextSettings);
	const registeredModels = applyLongContext(MODELS, longContextSettings);
	if (registeredModels.length === 0) {
		console.error(
			"claude-bridge: no models available from pi-ai's anthropic catalog — update @earendil-works/pi-ai (requires >=0.86.1)",
		);
	}

	if (!config.startupNoticeShown) {
		if (config.provider?.plan === undefined)
			pendingNotices.push(
				'Are you using a Max plan? You need to set provider.plan to "max" to unlock 1M context in Opus.',
			);
		if (config.askClaude?.enabled === undefined)
			pendingNotices.push("The AskClaude tool is opt-in only. Set askClaude.enabled to use it.");
	}

	// Reset shared session on pi session lifecycle events
	const clearSession = (event: string) => {
		debug(`${event}: clearing ${sharedSessions.size} shared session${sharedSessions.size === 1 ? "" : "s"}`);
		// Whole map: children never emit session_shutdown (only runtime teardown
		// and /reload do), so there is no per-entry removal to do here — the
		// top-level transition takes every mirror with it.
		sharedSessions.clear();
		pendingToolFailures.clear();
		historyRewrittenBySession.clear();

		// Clear the global streamSimple if this instance registered it.
		// This allows /reload to work — the old instance clears the flag so
		// the new instance can register fresh without wrapping stale state.
		const g = globalThis as Record<symbol, unknown>;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};
	pi.on("session_start", (event, ctx) => {
		piUI = ctx.ui;
		setSessionUI(ctx.ui);
		setStreamUI(ctx.ui);
		setLifecycleUI(ctx.ui);
		piMode = ctx.mode;
		if (config.provider?.shapeTrace === true) {
			new ShapeTrace(ctx.sessionManager.getSessionId()).recordPi("session_start", []);
		}
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	// `--system-prompt` replaces pi's default rather than adding to it, but Claude
	// Code's preset carries its own tool and permission guidance that the bridge
	// still depends on, so both flags are forwarded as an append.
	//
	// The options (custom/append/contextFiles/skills/sections) are pi config, stable across a
	// turn; only the auto-generated tool list in the rendered prompt varies. Stash them
	// at before_agent_start so the agent_start recording below can reuse them.
	type RecordOptions = Parameters<typeof recordSystemPrompt>[2];
	let lastSystemPromptOptions: RecordOptions | undefined;
	function recordSystemPrompt(
		source: string,
		systemPrompt: string | undefined,
		options:
			| {
					customPrompt?: string;
					appendSystemPrompt?: string;
					contextFiles?: { path: string; content: string }[];
					skills?: Parameters<typeof promptCaptures.record>[1]["skills"];
					sections?: Record<string, string>;
					selectedTools?: string[];
			  }
			| undefined,
	) {
		if (!systemPrompt) return;
		const hasRead = !options?.selectedTools || options.selectedTools.includes("read");
		promptCaptures.record(
			systemPrompt,
			{
				custom: options?.customPrompt,
				append: options?.appendSystemPrompt,
				contextFiles: options?.contextFiles ?? [],
				skills: hasRead ? (options?.skills ?? []) : [],
				sections: options?.sections,
			},
			source,
		);
	}
	pi.on("before_agent_start", (event) => {
		lastSystemPromptOptions = event.systemPromptOptions;
		recordSystemPrompt("before_agent_start", event.systemPrompt, event.systemPromptOptions);
	});
	// The prompt the provider actually queries with is the fully-widened one: MCP tool
	// descriptions merge into the system prompt only after their servers connect, which
	// is after before_agent_start. ctx.getSystemPrompt() returns that widened prompt by
	// agent_start (verified: before_agent_start=10,988 chars vs agent_start/query=23,479).
	// A subagent embeds the widened parent prompt verbatim (pi-subagents reads
	// ctx.getSystemPrompt() at dispatch), so unless the widened prompt is a capture key
	// too, the child's turn resolves against nothing, falls to a verbatim side request,
	// and ships pi's harness — tripping the server's third-party plan-eligibility check
	// ("out of extra usage"). Recording it here, before the query, restores the match.
	//
	// agent_start also captures a handler-returned forceSystemPrompt, which
	// buildSystemPrompt renders verbatim.
	pi.on("agent_start", (_event, ctx) => {
		recordSystemPrompt("agent_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});

	// Mid-run re-renders: turn_start fires before every turn (first turn included)
	// after the turn's prompt is final: prepareNextTurnWithContext has
	// re-rendered the options (pi's section-based prompt) and any mid-run
	// setActiveToolsByName rebuild has already landed. Re-keying at each boundary
	// the prompt can change at keeps exact-match alive mid-run. The stashed options can
	// lag a mid-run tool-loadout change, which skews the hasRead skills filter until the
	// next before_agent_start — accepted: a stale skills list beats failing the turn.
	pi.on("turn_start", (_event, ctx) => {
		recordSystemPrompt("turn_start", ctx.getSystemPrompt(), lastSystemPromptOptions);
	});
	pi.on("agent_end", (event, ctx) =>
		closeEndedTurn(ctx.sessionManager.getSessionId(), event.messages as Context["messages"]),
	);
	pi.on("session_shutdown", (_event, ctx) => {
		reportLeaks("session_shutdown");
		closeActiveQueries(ctx.sessionManager.getSessionId(), "pi session shut down");
		clearSession("session_shutdown");
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		debug(
			`session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
				`isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
				`turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		try {
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await compact(
				event.preparation,
				ctx.model,
				undefined,
				undefined,
				event.customInstructions,
				event.signal,
				undefined,
				(model, context, options) => isolatedStreamFn(model, context, { ...options, cwd: ctx.cwd }),
				undefined,
			);
			debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			const msg = errorMessage(err);
			debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
			ctx.ui?.notify?.(
				`Claude bridge compact failed (${msg}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history — and, when a
	// query is parked at a tool boundary while this fires, discard that query
	// instead of resuming it (markRebuild, discardRewrittenQuery).
	//
	// Attributed to the compacting session (ctx.sessionManager belongs to the
	// session whose runner fired this), so a subagent compacting while its
	// parent sits parked on the Agent tool result discards nothing — the parent's
	// query is live and its conversation untouched. Registered by every instance
	// of this module; instances sponsoring stale marks forward them to the
	// serving instance via sponsorMarkRebuildForSession.
	pi.on("session_compact", (event, ctx) =>
		sponsorMarkRebuildForSession(
			ctx.sessionManager.getSessionId(),
			`session_compact:${event.reason}:willRetry=${event.willRetry}`,
		),
	);
	pi.on("session_tree", (_event, ctx) =>
		sponsorMarkRebuildForSession(ctx.sessionManager.getSessionId(), "session_tree"),
	);

	// Branch summarization — rewind or fork-at-point with "summarize" — is the other
	// place pi asks the model for a summary, and unlike compaction it runs through
	// the *agent's* stream function (agent-session passes `streamFn:
	// this.agent.streamFunction`). On a bridge model that reaches this provider
	// carrying pi's internal summarization prompt, which no `before_agent_start`
	// ever recorded, so the prompt-capture resolver has nothing to resolve it to.
	// Take it over the way compaction is taken over: the summary runs as its own
	// Claude Code subprocess, never touching the live session or the resolver.
	pi.on("session_before_tree", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		const { entriesToSummarize, userWantsSummary, customInstructions, replaceInstructions } = event.preparation;
		if (!userWantsSummary || entriesToSummarize.length === 0) return undefined;
		debug(
			`session_before_tree: takeover entries=${entriesToSummarize.length} target=${event.preparation.targetId.slice(0, 8)}`,
		);
		try {
			const result = await generateBranchSummary(entriesToSummarize, {
				model: ctx.model,
				apiKey: "not-used",
				signal: event.signal,
				customInstructions,
				replaceInstructions,
				streamFn: (model, context, options) => isolatedStreamFn(model, context, { ...options, cwd: ctx.cwd }),
			});
			return branchSummaryOutcome(result);
		} catch (err) {
			debug("session_before_tree: takeover failed; cancelling navigation", err);
			ctx.ui?.notify?.(`Claude bridge branch summary failed (${errorMessage(err)}); navigation cancelled.`, "error");
			return { cancel: true };
		}
	});

	// --- Provider ---
	//
	// Registration policy across module instances (a subagent session can load
	// this module fresh): the FIRST instance registers unconditionally at load,
	// which is what puts claude-bridge models in the picker before any session
	// starts. Later instances decide at session_start, when ctx.modelRegistry
	// reveals who owns this session's registry:
	//
	// - Registry already has the provider (host passes the parent's registry down,
	//   e.g. pi-subagents >=0.14.3): skip. Re-registering would overwrite the
	//   parent's pinned streamSimple with this instance's fresh — empty-state —
	//   stream fn, and the parent's next tool-result delivery would route into it.
	// - Registry lacks the provider (host gives the child its own, e.g. older
	//   pi-subagents forks): register, or every claude-bridge/* dispatch in the
	//   child fails with "Model not found" (#91). Even loading the bridge via the
	//   agent's `extensions:` frontmatter didn't help there — the module loaded,
	//   hit the old skip-guard, and the child's registry stayed empty.
	//
	// A per-instance stream fn registered into a per-instance registry is
	// self-consistent: that session's traffic flows through this module state,
	// which starts clean and serves only that session.
	//
	// On session_shutdown (including /reload), clearSession() resets
	// ACTIVE_STREAM_SIMPLE_KEY so a freshly loaded module can register as first
	// again.

	const g = globalThis as Record<symbol, unknown>;
	const providerConfig = {
		baseUrl: "claude-bridge",
		apiKey: "not-used",
		api: "claude-bridge",
		models: registeredModels,
		streamSimple: streamClaudeAgentSdk,
	};
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		// First instance: store our streamSimple and register.
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, providerConfig);
	} else {
		// Later instance: register only if this session's registry lacks the provider.
		debug(`provider: deferring registration decision to session_start (module=${moduleInstanceId})`);
		pi.on("session_start", (_event, ctx) => {
			if (ctx.modelRegistry.getAll().some((model) => model.provider === PROVIDER_ID)) {
				debug(`provider: registry already has ${PROVIDER_ID}, skipping registration (module=${moduleInstanceId})`);
				return;
			}
			debug(`provider: registry lacks ${PROVIDER_ID}, registering (module=${moduleInstanceId})`);
			pi.registerProvider(PROVIDER_ID, providerConfig);
		});
	}

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const askDefaults = resolveAskClaudeDefaults(askConf);
	askClaudeToolName = askConf?.name ?? "AskClaude";

	if (askConf?.enabled) {
		const askClaudeParams = buildAskClaudeParams(askDefaults);
		pi.registerTool<typeof askClaudeParams>({
			name: askConf?.name ?? "AskClaude",
			label: askConf?.label ?? "Ask Claude Code",
			description: askClaudeToolDescription(askDefaults, askConf?.description),
			parameters: askClaudeParams,
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const tags = askClaudeCallTags(args, askDefaults);
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
				const truncated =
					args.prompt.length > PREVIEW_MAX_CHARS ? args.prompt.substring(0, PREVIEW_MAX_CHARS) : args.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (args.prompt.length > PREVIEW_MAX_CHARS || args.prompt.split("\n").length > PREVIEW_MAX_LINES)
					text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return new Text(theme.fg("mdLink", "◉ Claude Code ") + theme.fg("muted", status), 0, 0);
				}

				const details = result.details as
					| { prompt?: string; executionTime?: number; actions?: string; error?: boolean }
					| undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				let text = details?.error ? theme.fg("error", "✗ Claude Code error") : theme.fg("mdLink", "✓ Claude Code");

				if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
				if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

				if (expanded) {
					if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
					if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES)
						text += `\n${theme.fg("dim", `… (${keyHint("app.tools.expand", "to expand")})`)}`;
				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-bridge") {
					debug("askClaude: blocked circular delegation (active provider is claude-bridge)");
					return {
						content: [
							{
								type: "text" as const,
								text: "Error: AskClaude cannot be used when the active provider is claude-bridge — you're already running through Claude Code.",
							},
						],
						details: { error: true },
					};
				}

				const mode = resolveAskClaudeMode(params.mode, askDefaults);
				const isolated = params.isolated ?? askDefaults.isolated;
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls, ctx.cwd);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: params.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const result = await promptAndWait(ctx.cwd, params.prompt, mode, toolCalls, signal, {
						systemPrompt: ctx.getSystemPrompt(),
						appendSkills: askConf?.appendSkills,
						model: params.model,
						thinking: params.thinking,
						isolated,
						context: isolated
							? undefined
							: (buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"]),
						piSessionId: ctx.sessionManager.getSessionId(),
					});
					clearInterval(progressInterval);
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls, ctx.cwd);

					const text = actions
						? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
						: result.responseText;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: params.prompt, executionTime, actions },
					};
				} catch (err) {
					clearInterval(progressInterval);
					debug(
						`askClaude error: mode=${mode}, model=${params.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`,
						err,
					);
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: params.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}
}
