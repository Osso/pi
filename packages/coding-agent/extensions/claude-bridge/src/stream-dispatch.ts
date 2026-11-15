import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { prepareProviderAccount } from "./account-runtime.ts";
import { debug, diagDump } from "./diagnostics.ts";
import type { McpResult } from "./extract-tool-results.ts";
import { extractUserPrompt, extractUserPromptBlocks } from "./isolated-summary.ts";
import { CONTINUE_AFTER_REWRITE_PROMPT, deliverToolResults, steerBlocks } from "./query-lifecycle.ts";
import { activeQueryContexts, piRequests, QueryContext } from "./query-state.ts";
import { historyRewrittenBySession, sessionStateFor } from "./session-mirror.ts";
import { claimCurrentPiStream, finalizeCurrentStream } from "./stream-events.ts";

/** A tool failed after its query died; answer the returning tool result with that failure. */
export function emitDeferredToolFailure(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	errorMessage: string,
): void {
	const failed = new QueryContext();
	failed.resetTurnState(model);
	const output = failed.turnOutput;
	if (!output) throw new Error("Failed to initialize deferred Claude error response");
	output.stopReason = "error";
	output.errorMessage = errorMessage;
	claimCurrentPiStream(stream, "late-tool-error", failed);
	queueMicrotask(() => finalizeCurrentStream(failed, "error"));
}

/** Deliver this turn's tool results to the query parked on them. */
export function continueWithToolResults(
	stream: AssistantMessageEventStream,
	resultCtx: QueryContext,
	request: { model: Model<Api>; context: Context; options?: SimpleStreamOptions },
	allResults: McpResult[],
	lastMsgRole: string | undefined,
): void {
	const { model, context } = request;
	claimCurrentPiStream(stream, "tool-result", resultCtx);
	piRequests.set(stream, request);
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
}

export function resolveFreshPromptText(
	context: Context,
	queryCtx: QueryContext,
	piSessionId: string | null,
	lastMsgRole: string | undefined,
	isReentrant: boolean,
	rewrittenUnderQuery: boolean,
	quotaRetry: boolean,
	continuingFromToolResults: boolean,
): { promptText: string; promptBlocks: ReturnType<typeof extractUserPromptBlocks> } {
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	if ((rewrittenUnderQuery || quotaRetry) && !promptText && !promptBlocks) {
		promptText = CONTINUE_AFTER_REWRITE_PROMPT;
		debug(`provider: continuing the turn after a rewritten history, ${context.messages.length} msgs rebuilt`);
	}
	if (continuingFromToolResults && !promptText && !promptBlocks) {
		promptText = "[Continue the user's task from the completed tool results above.]";
	}
	if (!promptText && !promptBlocks) {
		const sessionState = sessionStateFor(piSessionId);
		const defaultSessionState = sessionStateFor(null);
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: sessionState
				? { sessionId: sessionState.sessionId.slice(0, 8), cursor: sessionState.cursor }
				: defaultSessionState
					? { sessionId: defaultSessionState.sessionId.slice(0, 8), cursor: defaultSessionState.cursor }
					: null,
			messageRoles: context.messages.map((message, index) => `[${index}]${message.role}`).join(" "),
		});
		promptText = "[continue]";
	}
	return { promptText, promptBlocks };
}

export function resetQueryContextForFreshQuery(
	queryCtx: QueryContext,
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	account: ReturnType<typeof prepareProviderAccount>,
	context: Context,
): void {
	queryCtx.turnToolCallIds = [];
	queryCtx.resetTurnState(model);
	queryCtx.latestCursor = context.messages.length;
	queryCtx.turnEnded = false;
	queryCtx.piSessionId = options?.sessionId ?? null;
	queryCtx.historyStale = false;
	queryCtx.missedSteer = false;
	queryCtx.rateLimitRejection = null;
	queryCtx.quotaFailure = null;
	queryCtx.accountProfile = account ? { name: account.name, manager: account.manager } : null;
}
