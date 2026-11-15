import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Context } from "@earendil-works/pi-ai";
import { debug } from "./diagnostics.ts";
import type { McpResult } from "./extract-tool-results.ts";
import { extractUserPrompt, extractUserPromptBlocks } from "./isolated-summary.ts";
import { type PromptStream, userMessage } from "./prompt-stream.ts";
import { activeQueryContexts, type QueryContext } from "./query-state.ts";
import { historyRewrittenBySession, sessionStateFor, setSessionStateFor } from "./session-mirror.ts";
import { piUI } from "./ui-state.ts";

/** The trailing user turn as content blocks, or null if there isn't one.
 *  Blocks rather than text so image steers keep their images. */
export function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const blocks = extractUserPromptBlocks(messages);
	if (blocks) return blocks;
	const text = extractUserPrompt(messages);
	return text ? [{ type: "text", text }] : null;
}

/** A steer that never made it into CC's session. The cursor has already counted
 *  it, so count-based sync would skip it forever — rebuild instead, which
 *  re-imports the message from pi's context. */
export function steerMissedSession(c: QueryContext, text: string): void {
	c.missedSteer = true;
	const state = sessionStateFor(c.piSessionId);
	if (state) setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true });
	debug(`provider: steer never reached CC, marked query for rebuild: ${text.slice(0, 60)}`);
}

/** Releases this turn's tool results to their MCP handlers, after first pushing
 *  any steer to CC.
 *
 *  The ordering is mandatory, not an optimization. The steer and the MCP tool
 *  result travel back to CC over the same stdin FIFO. Awaiting the push ack
 *  (which resolves only once the SDK's write to stdin completed) before
 *  resolving any handler guarantees CC enqueues the steer *before* it reads the
 *  tool result, so its post-tool-call drain sees it and acts on it this turn.
 *  Resolve first and the steer misses the drain, silently degrading to
 *  follow-up semantics.
 *
 *  Both the post-tool-call drain and the FIFO ordering are CC CLI internals,
 *  not SDK contract, so a Claude Code update can change them. */
export async function deliverToolResults(
	c: QueryContext,
	results: McpResult[],
	steer: ContentBlockParam[] | null,
	contextLength: number,
): Promise<void> {
	if (steer) {
		const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
		if (!c.promptStream) {
			debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
			steerMissedSession(c, text);
		} else {
			try {
				await c.promptStream.push(userMessage(steer, "next"));
				debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
			} catch (error) {
				// The query is ending — pushing further input would wedge tool-result
				// delivery, so the steer doesn't reach this query. It is still in
				// pi's context, and the caller has already advanced the session
				// cursor past it, so force a rebuild or CC would never see it.
				debug(`provider: steer push rejected, delivering tool result anyway:`, error);
				steerMissedSession(c, text);
			}
		}
	}

	debug(
		`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`,
	);
	for (const result of results) {
		const id = result.toolCallId;
		const pending = id ? c.pendingToolCalls.get(id) : undefined;
		if (id && pending) {
			c.pendingToolCalls.delete(id);
			debug(
				`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`,
				JSON.stringify(result.content).slice(0, 200),
			);
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
		if (c.pendingToolCalls.size > 0 && c.pendingResults.size > 0) {
			debug(`BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`);
		}
	}
	if (c.pendingToolCalls.size > 0) {
		debug(
			`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`,
		);
		piUI?.notify(
			`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`,
			"warning",
		);
	}
}

/** Abort teardown for one query: settle everything that would otherwise be left
 *  awaiting a subprocess we are about to kill. The pump abandons iteration on
 *  abort, so an in-flight prompt-stream push would hang forever and take
 *  tool-result delivery with it. */
export function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
	promptStream.fail(new Error("Operation aborted"));
	c.releasePendingToolCalls("Operation aborted");
}

/** Queries pi's history moved out from under. Their completion must not touch
 *  `sharedSession` or the pi stream: the query that took over the turn has
 *  already rebuilt both from the new history, and this one's session id names the
 *  conversation pi just discarded. */
export const abandonedQueries = new WeakSet<object>();

/** The prompt a continuation query is opened with: the pi turn goes on, but its
 *  last message is a tool result rather than a prompt, and query() cannot resume
 *  a session without one. */
export const CONTINUE_AFTER_REWRITE_PROMPT =
	"[Your context was compacted. What precedes this is a summary plus the most recent messages, " +
	"ending with the tool result you were waiting for. Continue the task from there.]";

/** Drop a Claude Code query parked at a tool boundary whose conversation pi has
 *  since rewritten (/compact, tree navigation).
 *
 *  Delivering the turn's tool result into that query hands Claude Code the
 *  context pi just shrank: one pi turn is one CC query, and the query keeps its
 *  own context inside the CLI whatever pi does to its transcript. It answers off
 *  the pre-compaction conversation, reports the pre-compaction usage back, and pi
 *  crosses the same threshold at the next boundary — measured as one compaction
 *  per tool call with usage never dropping (issue #101). `needsRebuild` does not
 *  prevent it: only syncSharedSession reads that flag, and tool-result delivery
 *  is the one call that never syncs.
 *
 *  The caller then takes the fresh-query path, where REBUILD imports pi's
 *  rewritten history — this tool result included, since it is already in that
 *  history — so the turn continues instead of ending here. Nothing is lost by
 *  killing the subprocess: pi owns the only copy of the conversation that counts. */
export function discardRewrittenQuery(c: QueryContext): void {
	const discarded = c.activeQuery as { interrupt?: () => Promise<unknown>; close?: () => void } | null;
	if (discarded) abandonedQueries.add(discarded);
	c.activeQuery = null;
	// Leaving the routing set is what stops this result coming straight back here:
	// contextForToolResults only matches ids against contexts still in it.
	activeQueryContexts.delete(c);
	c.turnToolCallIds = [];
	c.promptStream?.fail(new Error("conversation rewritten"));
	c.promptStream = null;
	// Settle the parked handlers before killing the CLI, for drainForAbort's
	// reason: one left awaiting a dead subprocess never settles.
	c.releasePendingToolCalls("Context was compacted; this query was discarded.");
	void discarded?.interrupt?.().catch(() => {});
	try {
		discarded?.close?.();
	} catch {}
	// The CLI we just killed may still flush a record into the session JSONL, and
	// the rebuild is the next thing that happens — so rotate rather than race it,
	// exactly as after an abort. Only this session's mirror: the discarding query
	// proves its own conversation is the one being rebuilt around.
	const state = sessionStateFor(c.piSessionId);
	if (state) setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
	if (c.piSessionId) historyRewrittenBySession.delete(c.piSessionId);
	debug("provider: history rewritten under a parked query — discarded it, rebuilding from current history");
}

/** Close Claude Code queries owned by the pi session shutting down.
 *
 *  A tool whose result ends pi's turn (`terminate: true`) leaves its MCP handler
 *  parked: pi never makes the provider call that would deliver the result. On a
 *  signal, pi's teardown kills the child; a clean exit (print mode) has nothing
 *  else that will, and the live subprocess keeps pi's event loop running. */
export function closeActiveQueries(piSessionId: string | null, reason: string): void {
	for (const c of activeQueryContexts) {
		if (c.piSessionId !== piSessionId) continue;
		const open = c.activeQuery as { interrupt?: () => Promise<unknown>; close?: () => void } | null;
		if (open) abandonedQueries.add(open);
		c.activeQuery = null;
		c.turnToolCallIds = [];
		c.promptStream?.fail(new Error(reason));
		c.promptStream = null;
		// Settle parked handlers before killing the CLI: one left awaiting a dead
		// subprocess never settles.
		c.releasePendingToolCalls(reason);
		void open?.interrupt?.().catch(() => {});
		try {
			open?.close?.();
		} catch {}
		activeQueryContexts.delete(c);
	}
}
