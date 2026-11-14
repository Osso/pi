import { type EffortLevel, query } from "@anthropic-ai/claude-agent-sdk";
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
import type { BranchSummaryResult } from "../../../src/core/compaction/branch-summarization.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	claudeExecutable,
	emitAccountPreparationFailure,
	errorMessage,
	fetchAccountRetryProfiles,
	markStreamComplete,
	prepareProviderAccount,
	providerSettings,
	resetAccountProfiles,
} from "./account-runtime.ts";
import { recordAuthFailure, recordCredentialTrace } from "./auth-trace.ts";

import { claudeCodeSettings, markStartupNoticeShown } from "./config.ts";
import { debug, diagDump, makeCliDebugOptions } from "./diagnostics.ts";
import { registerExtension } from "./extension-registration.ts";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.ts";
import {
	CC_CHILD_ENV,
	extractUserPrompt,
	extractUserPromptBlocks,
	isolatedStreamFn,
	longContextSettings,
	requireSessionCwd,
	resultErrorText,
	setIsolatedQueryImpl,
} from "./isolated-summary.ts";
import { createToolServer } from "./mcp-server.ts";
import { buildModels, claudeCodeModelId } from "./models.ts";
import { CLAUDE_MD_EXCLUDES, REASONING_TO_EFFORT, setAskClaudeQueryImpl } from "./prompt-and-wait.ts";
import { type PromptCapture, projectPromptCapture, sharedPromptCaptures } from "./prompt-capture.ts";
import { makePromptStream, type PromptStream, userMessage } from "./prompt-stream.ts";
import {
	abandonedQueries,
	CONTINUE_AFTER_REWRITE_PROMPT,
	deliverToolResults,
	discardRewrittenQuery,
	drainForAbort,
	steerBlocks,
} from "./query-lifecycle.ts";
import { ACCOUNTS_EXHAUSTED, activeQueryContexts, ctx, QueryContext } from "./query-state.ts";
import {
	armStaleContexts,
	deleteEphemeralSession,
	extractAllToolResults,
	historyRewrittenBySession,
	markRebuildForSession,
	type SessionState,
	sessionStateFor,
	setSessionStateFor,
	sharedSessions,
	syncSharedSession,
} from "./session-mirror.ts";
import { ShapeTrace } from "./shape-trace.ts";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.ts";
import { claimCurrentPiStream, consumeQuery, finalizeCurrentStream } from "./stream-events.ts";
import { piUI, setPiUI } from "./ui-state.ts";

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
// --- Constants ---

// Marks which bridge module instance owns the registered provider's stream fn.
// Full registration policy (first vs later instances, shared vs own registry):
// see the "--- Provider ---" block in activate() below.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

// Claude Code's own builtin tools, for the AskClaude path where CC really runs
// them. The provider enables only native WebSearch, not these tools.
// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
const MODELS = buildModels(getModels("anthropic"));
const quotaRetrySessions = new Set<string | null>();
let askClaudeToolName = "AskClaude";

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
// The SDK's query(), or a test double (see setQuery). The compact/summary
// path calls the real query() directly — its subprocess must never be swapped
// out from under a real compaction.
let queryImpl: typeof query = query;

// @internal
export const __test = {
	setQuery(fn: typeof query | null) {
		queryImpl = fn ?? query;
	},
	setIsolatedQuery(fn: typeof query | null) {
		setIsolatedQueryImpl(fn);
	},
	setAskClaudeQuery(fn: typeof query | null) {
		setAskClaudeQueryImpl(fn);
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
	setPiUI,
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
				deleteEphemeralSession(capturedSessionId, state?.sessionId, cwd);
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

export default function (pi: ExtensionAPI) {
	registerExtension(pi, {
		models: MODELS,
		pendingNotices,
		setPiMode(mode) {
			piMode = mode;
		},
		clearPendingToolFailures() {
			pendingToolFailures.clear();
		},
		setAskClaudeToolName(name) {
			askClaudeToolName = name;
		},
		streamClaudeAgentSdk,
		activeStreamSimpleKey: ACTIVE_STREAM_SIMPLE_KEY,
		promptCaptures,
		closeEndedTurn,
		reportLeaks,
		branchSummaryOutcome,
	});
}
