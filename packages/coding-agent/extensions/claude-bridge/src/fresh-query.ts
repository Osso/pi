import type { EffortLevel, query } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	claudeExecutable,
	errorMessage,
	markStreamComplete,
	type prepareProviderAccount,
	providerSettings,
} from "./account-runtime.ts";
import { claudeCodeSettings } from "./config.ts";
import { debug, makeCliDebugOptions } from "./diagnostics.ts";
import { CC_CHILD_ENV } from "./isolated-summary.ts";
import type { PromptStream } from "./prompt-stream.ts";
import { abandonedQueries, drainForAbort } from "./query-lifecycle.ts";
import { activeQueryContexts, type QueryContext } from "./query-state.ts";
import {
	deleteEphemeralSession,
	sessionStateFor,
	setSessionStateFor,
	type syncSharedSession,
} from "./session-mirror.ts";
import { consumeQuery, finalizeCurrentStream } from "./stream-events.ts";

type QueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;
type ProviderAccount = ReturnType<typeof prepareProviderAccount>;

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);
const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
};

// Pi's appended system prompt carries the project context; CC must not load its own copy.
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

export interface FreshQueryOptionsInput {
	model: Model<Api>;
	options: SimpleStreamOptions | undefined;
	cwd: string;
	cliModel: string;
	account: ProviderAccount;
	queryCtx: QueryContext;
	systemPromptAppend: string | undefined;
	mcpServers: QueryOptions["mcpServers"];
	resumeSessionId: string | null | undefined;
}

/** Claude Code query options for a fresh provider query. */
export function buildFreshQueryOptions(input: FreshQueryOptionsInput): {
	queryOptions: QueryOptions;
	effort: EffortLevel | undefined;
	strictMcpConfigEnabled: boolean;
} {
	const { model, options, cwd, cliModel, account, queryCtx, systemPromptAppend, mcpServers, resumeSessionId } = input;
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
		// the prompt cache for the whole conversation from there on. The bridge re-invokes CC per turn, so this
		// hit on every transition. Cost here is nil: the setting also strips
		// CC's git-workflow guidance from its Bash tool prompt, but the provider
		// path enables only native WebSearch, so Bash's definitions never ship.
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
		// request. Other batches continue as usual.
		hooks: { PostToolBatch: [{ hooks: [async () => (queryCtx.turnEnded ? { continue: false } : {})] }] },
		...(effort ? { effort } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions("provider", account),
	};
	return { queryOptions, effort, strictMcpConfigEnabled };
}

/** One started fresh query: what its settle handlers read and the abort flag they share. */
export interface FreshQueryRun {
	queryCtx: QueryContext;
	sdkQuery: ReturnType<typeof query>;
	promptStream: PromptStream;
	account: ProviderAccount;
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions | undefined;
	cliModel: string;
	cwd: string;
	syncResult: ReturnType<typeof syncSharedSession>;
	isReentrant: boolean;
	abort: { wasAborted: boolean };
}

/** Index-owned account and failure handling the settle chain calls back into. */
export interface FreshQueryHooks {
	settleAccount(
		queryCtx: QueryContext,
		sdkQuery: ReturnType<typeof query>,
		account: ProviderAccount,
		cancelled: boolean | undefined,
	): void;
	replayOnNextAccount(queryCtx: QueryContext): boolean;
	retainPendingToolFailure(queryCtx: QueryContext): void;
}

/** Wire abort handling and consume the started query in the background. */
export function runFreshQuery(
	run: FreshQueryRun,
	customToolNameToPi: Parameters<typeof consumeQuery>[1],
	hooks: FreshQueryHooks,
): void {
	const { queryCtx, sdkQuery, promptStream, account, model, options } = run;
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
		run.abort.wasAborted = true;
		drainForAbort(abortCtx, promptStream);
		requestAbort();
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Background consumer — runs until query ends
	queryCtx.settled = consumeQuery(sdkQuery, customToolNameToPi, model, () => run.abort.wasAborted, queryCtx)
		.catch((error) => {
			if (!abandonedQueries.has(sdkQuery) && queryCtx.turnOutput) {
				queryCtx.turnOutput.stopReason = "error";
				queryCtx.turnOutput.errorMessage ??= errorMessage(error);
			}
			throw error;
		})
		.finally(() => hooks.settleAccount(queryCtx, sdkQuery, account, run.abort.wasAborted || options?.signal?.aborted))
		.then(async ({ capturedSessionId }) => handleQuerySettled(run, capturedSessionId, hooks))
		.catch((error) => handleQueryFailure(run, error, hooks))
		.finally(() => cleanupQuery(run, onAbort));
}

function handleQuerySettled(
	run: FreshQueryRun,
	capturedSessionId: Awaited<ReturnType<typeof consumeQuery>>["capturedSessionId"],
	hooks: FreshQueryHooks,
): void {
	const { queryCtx, sdkQuery, options, syncResult, cwd, context, isReentrant } = run;
	const { wasAborted } = run.abort;
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
	if (hooks.replayOnNextAccount(queryCtx)) return;
	hooks.retainPendingToolFailure(queryCtx);
	finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
}

function handleQueryFailure(run: FreshQueryRun, error: unknown, hooks: FreshQueryHooks): void {
	const { queryCtx, sdkQuery, options, promptStream, isReentrant, cliModel } = run;
	const { wasAborted } = run.abort;
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
	if (!wasAborted && !options?.signal?.aborted && hooks.replayOnNextAccount(queryCtx)) return;
	hooks.retainPendingToolFailure(queryCtx);
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
}

function cleanupQuery(run: FreshQueryRun, onAbort: () => void): void {
	const { queryCtx, sdkQuery, options, promptStream } = run;
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
}
