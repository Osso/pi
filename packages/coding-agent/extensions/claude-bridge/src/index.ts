import { query } from "@anthropic-ai/claude-agent-sdk";
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
	emitAccountPreparationFailure,
	errorMessage,
	fetchAccountRetryProfiles,
	markStreamComplete,
	prepareProviderAccount,
	resetAccountProfiles,
} from "./account-runtime.ts";
import { recordAuthFailure, recordCredentialTrace } from "./auth-trace.ts";

import { markStartupNoticeShown } from "./config.ts";
import { debug, diagDump } from "./diagnostics.ts";
import { registerExtension } from "./extension-registration.ts";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.ts";
import { buildFreshQueryOptions, type FreshQueryHooks, runFreshQuery } from "./fresh-query.ts";
import {
	CC_CHILD_ENV,
	extractUserPromptBlocks,
	isolatedStreamFn,
	longContextSettings,
	requireSessionCwd,
	resultErrorText,
	setIsolatedQueryImpl,
} from "./isolated-summary.ts";
import { createToolServer } from "./mcp-server.ts";
import { buildModels, claudeCodeModelId } from "./models.ts";
import { type PromptCapture, projectPromptCapture, sharedPromptCaptures } from "./prompt-capture.ts";
import { makePromptStream, type PromptStream, userMessage } from "./prompt-stream.ts";
import { abandonedQueries, deliverToolResults, discardRewrittenQuery, drainForAbort } from "./query-lifecycle.ts";
import { ACCOUNTS_EXHAUSTED, activeQueryContexts, ctx, piRequests, QueryContext } from "./query-state.ts";
import {
	armStaleContexts,
	extractAllToolResults,
	historyRewrittenBySession,
	markRebuildForSession,
	setSessionStateFor,
	sharedSessions,
	syncSharedSession,
} from "./session-mirror.ts";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.ts";
import {
	continueWithToolResults,
	emitDeferredToolFailure,
	resetQueryContextForFreshQuery,
	resolveFreshPromptText,
} from "./stream-dispatch.ts";
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

// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
const MODELS = buildModels(getModels("anthropic"));
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

// Defaults that silently cost the user something (no Opus 1M on Max) are
// announced once. Deferred to the first bridge query rather
// than session_start: the notice persists a flag to the global config, and
// firing it on startup would write that file for every pi session that merely
// has this extension installed. One message, because consecutive info notifies
// overwrite each other in the TUI.
const pendingNotices: string[] = [];

function showStartupNoticeOnce(): void {
	// `hasUI` is true in RPC mode too — it means dialogs are possible, not that a
	// human is watching. Only a terminal user can act on this.
	if (pendingNotices.length === 0 || piMode !== "tui") return;
	const notices = pendingNotices.splice(0);
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
 *  where the real sessions are. */
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

function resolveMcpTools(context: Context): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === "web_search") continue;
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
function prepareQueryInputs(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
	mcpTools: Tool[],
	isReentrantUserQuery: boolean,
	allowQuotaRecheck: boolean,
):
	| {
			account: ReturnType<typeof prepareProviderAccount>;
			promptCapture: PromptCapture | undefined;
			systemPromptAppend: string | undefined;
	  }
	| undefined {
	let account: ReturnType<typeof prepareProviderAccount>;
	try {
		account = prepareProviderAccount();
	} catch (error) {
		if (allowQuotaRecheck && error instanceof Error && error.message === ACCOUNTS_EXHAUSTED) {
			void resumeAfterAccountRecheck(stream, model, context, options);
		} else {
			emitAccountPreparationFailure(stream, model, error);
		}
		return undefined;
	}

	try {
		const promptCapture = promptCaptures.resolveOrDerive(context.systemPrompt);
		const systemPromptAppend = promptCapture
			? projectPromptCapture(promptCapture, {
					skillReadTool: mcpTools.some((tool) => tool.name === "read") ? "mcp" : "none",
				})
			: undefined;
		return { account, promptCapture, systemPromptAppend };
	} catch (error) {
		emitAccountPreparationFailure(stream, model, error);
		diagDump("prompt_capture_unresolved", {
			promptChars: context.systemPrompt?.length ?? 0,
			knownKeys: promptCaptures.size,
			reentrantUserQuery: isReentrantUserQuery,
			error: errorMessage(error),
		});
		return undefined;
	}
}

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
		emitDeferredToolFailure(stream, model, pendingFailure.errorMessage);
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
		continueWithToolResults(stream, resultCtx, { model, context, options }, allResults, lastMsgRole);
		return stream;
	}

	// --- Unowned tool results ---
	// No live query owns these results: the query ended while Pi ran the tools (a long
	// wait, a detached tool, a new process) or another provider made the calls. Pi still
	// expects an answer, so a fresh query over the rebuilt history continues the turn.
	const lastMsg = context.messages[context.messages.length - 1];
	const continuingFromToolResults = lastMsg?.role === "toolResult";

	// --- Fresh query ---
	pendingToolFailures.delete(piSession);

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query.
	const isReentrant = activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	// Resolve this before claiming or resetting shared query state. A failure must not
	// leave a stream claimed on a context that nobody can finish.
	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
	const queryInputs = prepareQueryInputs(
		model,
		context,
		options,
		stream,
		mcpTools,
		isReentrantUserQuery,
		allowQuotaRecheck,
	);
	if (!queryInputs) return stream;
	const { account, promptCapture, systemPromptAppend } = queryInputs;

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx);
	piRequests.set(stream, { model, context, options });
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	resetQueryContextForFreshQuery(queryCtx, model, options, account, context);
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
	const { promptText, promptBlocks } = resolveFreshPromptText(
		context,
		queryCtx,
		piSessionId,
		lastMsg?.role,
		isReentrant,
		rewrittenUnderQuery,
		quotaRetry,
		continuingFromToolResults,
	);

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

	const { queryOptions, effort, strictMcpConfigEnabled } = buildFreshQueryOptions({
		model,
		options,
		cwd,
		cliModel,
		account,
		queryCtx,
		systemPromptAppend,
		mcpServers,
		resumeSessionId,
	});

	debug(
		"provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`,
	);

	// 3. Start SDK query and claim it for this context
	let sdkQuery: ReturnType<typeof query>;
	try {
		sdkQuery = queryImpl({ prompt: promptStream.stream, options: queryOptions });
	} catch (error) {
		failQueryStartup(queryCtx, promptStream, account, error);
		return stream;
	}
	queryCtx.activeQuery = sdkQuery;
	activeQueryContexts.add(queryCtx);

	runFreshQuery(
		{
			queryCtx,
			sdkQuery,
			promptStream,
			account,
			model,
			context,
			options,
			cliModel,
			cwd,
			syncResult,
			isReentrant,
			abort: { wasAborted: false },
		},
		customToolNameToPi,
		freshQueryHooks,
	);

	return stream;
}

const freshQueryHooks: FreshQueryHooks = {
	settleAccount: settleQueryAccount,
	replayOnNextAccount,
	retainPendingToolFailure,
};

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
		streamClaudeAgentSdk,
		activeStreamSimpleKey: ACTIVE_STREAM_SIMPLE_KEY,
		promptCaptures,
		closeEndedTurn,
		reportLeaks,
		branchSummaryOutcome,
	});
}
