import type { query, SDKMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, ToolCall } from "@earendil-works/pi-ai";
import { appendFileSync } from "fs";
import {
	classifyAccountFailure,
	completedStreams,
	logServedContextWindow,
	markStreamComplete,
	recordUsage,
} from "./account-runtime.ts";
import { debug } from "./diagnostics.ts";
import { describeRateLimitFailure, resultErrorText } from "./isolated-summary.ts";
import type { QueryContext } from "./query-state.ts";
import { piUI } from "./ui-state.ts";

// --- Provider helpers: tool name mapping ---

// Only the pi tools we serve over MCP reach pi. Native WebSearch
// runs inside CC; other unserved names (`bash`, `Bash`, `Edit`, foreign MCP tools)
// are rejected by CC and retried without dispatching to our MCP server.
// Neither kind may reach pi. Forwarding an unserved call ran a tool CC never
// dispatched (real side effects) and, because the retry carries a fresh
// tool_use id, left the handler for the retry with no result to release it:
// pi's result arrived keyed to the dead id, and both sides deadlocked.
export function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
	return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase());
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read: { file_path: "path" },
	write: { file_path: "path" },
	edit: { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
export function mapToolArgs(toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	return result;
}

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		default:
			return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try {
		const parsed: unknown = JSON.parse(input);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: fallback;
	} catch {
		return fallback;
	}
}

// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.

export function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(
			`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`,
		);
	}
	c.currentPiStream = stream;
}

export function ensureTurnStarted(c: QueryContext): void {
	const stream = c.currentPiStream;
	const output = c.turnOutput;
	if (!c.turnStarted && stream && output) {
		stream.push({ type: "start", partial: output });
		c.turnStarted = true;
	}
}

/** Pi stores the delivered message in its transcript state, while the query keeps writing to
 *  turnOutput: an error result or an abort at the tool boundary sets its stopReason later. Pi gets
 *  its own copy, so a toolUse turn it already recorded cannot turn into an aborted one in memory and
 *  drop out of the next request, leaving its tool result without a call. */
function deliveredMessage(output: AssistantMessage): AssistantMessage {
	return { ...output, content: [...output.content] };
}

export function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
	const stream = c.currentPiStream;
	const output = c.turnOutput;
	if (!stream || !output) return;
	debug(
		`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({ stopReason: output.stopReason, error: output.errorMessage })}`,
	);
	if (!c.turnStarted) ensureTurnStarted(c);
	if (output.stopReason === "error") {
		stream.push({ type: "error", reason: "error", error: output });
	} else {
		const reason = stopReason === "length" ? "length" : "stop";
		stream.push({ type: "done", reason, message: deliveredMessage(output) });
	}
	markStreamComplete(stream);
	stream.end();
	c.currentPiStream = null;
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKPartialAssistantMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<Api>,
	c: QueryContext,
): void {
	const stream = c.currentPiStream;
	const output = c.turnOutput;
	if (!stream || !output) return;
	c.turnSawStreamEvent = true;
	const event: SDKPartialAssistantMessage["event"] | { type: "ping" } = message.event;

	if (event?.type === "message_start") {
		// Still open from an earlier message_start: Claude Code gave up on that
		// stream and is retrying it. Its blocks were never completed.
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `restreamed as ${event.message?.id}`);
		c.turnToolCallIds = [];
		c.turnStreamMessageId = event.message?.id;
		c.turnStreamOpen = true;
		c.turnStreamBlockStart = c.turnBlocks.length;
		if (event.message?.usage) recordUsage(output, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			stream.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: output });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			stream.push({
				type: "thinking_start",
				contentIndex: c.turnBlocks.length - 1,
				partial: output,
			});
		} else if (event.content_block?.type === "tool_use") {
			const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
			if (!piName) {
				debug(
					`processStreamEvent: skipping tool_use outside pi's MCP tools ${event.content_block.name} [${event.content_block.id}] — handled internally by CC`,
				);
				return;
			}
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall",
				id: event.content_block.id,
				name: piName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "",
				index: event.index,
			});
			stream.push({
				type: "toolcall_start",
				contentIndex: c.turnBlocks.length - 1,
				partial: output,
			});
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			stream.push({
				type: "text_delta",
				contentIndex: index,
				delta: event.delta.text,
				partial: output,
			});
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			stream.push({
				type: "thinking_delta",
				contentIndex: index,
				delta: event.delta.thinking,
				partial: output,
			});
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson = (block.partialJson ?? "") + event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			stream.push({
				type: "toolcall_delta",
				contentIndex: index,
				delta: event.delta.partial_json,
				partial: output,
			});
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
		} else if (block.type === "thinking") {
			stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: output,
			});
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson ?? "", block.arguments));
			delete block.partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
		}
		return;
	}

	if (event?.type === "message_delta") {
		output.stopReason = mapStopReason(event.delta?.stop_reason ?? undefined);
		if (event.usage) recordUsage(output, event.usage, model);
		return;
	}

	if (event?.type === "message_stop") c.turnStreamOpen = false;

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this pi stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		output.stopReason = "toolUse";
		stream.push({ type: "done", reason: "toolUse", message: deliveredMessage(output) });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	const eventType: string | undefined = event?.type;
	if (eventType !== "message_stop" && eventType !== "ping") {
		debug("processStreamEvent: unhandled event type", eventType);
	}
}

/** Remove the blocks a stream Claude Code abandoned mid-message. They never got a
 *  message_stop, so a thinking block has no signature and a tool call is one CC will
 *  never dispatch; left in, pi would run the tool and the turn would wait on a
 *  handler that never comes, or the next request would replay a broken block.
 *  The fallback then restarts those indices. pi's normal provider path tolerates that;
 *  pi-agent-core's experimental harness frame encoder keys blocks by contentIndex and
 *  rejects a repeated start, so it would need a change there to drive this provider. */
function dropAbandonedStreamBlocks(c: QueryContext, why: string): void {
	const dropped = c.turnBlocks.splice(c.turnStreamBlockStart);
	debug(
		`dropAbandonedStreamBlocks: ${why}; dropped ${dropped.length} blocks from ${c.turnStreamMessageId} types=${dropped.map((b) => b.type).join(",")}`,
	);
	c.turnToolCallIds = [];
	c.turnSawToolCall = c.turnBlocks.some((b) => b.type === "toolCall");
	c.turnStreamOpen = false;
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
//
// It is also the content path when a stream stalls: Claude Code drops it and asks
// again without streaming ("Error streaming, falling back to non-streaming mode"),
// and the answer arrives as one assistant message, under a new message id, with no
// stream_events of its own. turnSawStreamEvent is already set by the dead stream,
// so gating on it alone dropped that message: its tool calls never reached pi, CC
// sat in the MCP handler waiting for their results, and the turn hung on "Working"
// until the user aborted it.
function processAssistantMessage(
	message: Extract<SDKMessage, { type: "assistant" }>,
	model: Model<Api>,
	customToolNameToPi: Map<string, string>,
	c: QueryContext,
): void {
	const assistantMsg = message.message;
	if (!assistantMsg?.content) return;
	const output = c.turnOutput;
	if (!output) throw new Error("Claude assistant message arrived before turn output was initialized");
	// Claude Code reports API failures and its own quota/context notices as a
	// `<synthetic>` assistant message: a report, not model output. Streaming its text
	// pins the turn's output before the failure it describes, and a consumer that only
	// fails over before output commits (pi-model-fallback-alias) then cannot reach the
	// next provider. Keep the wording on the failed turn — the error event carries it —
	// but emit no events, so the turn still reads as a call that produced no output.
	// Issue #162.
	if (assistantMsg.model === "<synthetic>") {
		// The report can follow a stalled stream whose non-streaming retry also failed;
		// drop the abandoned partial blocks (unsigned thinking, a tool call CC will never
		// dispatch) the way the fallback path below would.
		if (c.turnSawStreamEvent && c.turnStreamOpen) dropAbandonedStreamBlocks(c, "synthetic failure report");
		debug(
			`processAssistantMessage: <synthetic> message, keeping ${assistantMsg.content.length} block(s) off the stream`,
		);
		for (const block of assistantMsg.content) {
			if (block.type === "text" && block.text) c.turnBlocks.push({ type: "text", text: block.text });
			else debug("processAssistantMessage: unhandled <synthetic> block type", block.type);
		}
		if (assistantMsg.usage) recordUsage(output, assistantMsg.usage, model);
		return;
	}
	if (c.turnSawStreamEvent) {
		// Same id was already delivered; a new id is CC's non-streaming fallback.
		// Drop the stalled stream's partial blocks if it never stopped. Deliberately
		// deliver even if it stopped, at the risk of duplication if CC renumbers it.
		const id = assistantMsg.id;
		if (!id || !c.turnStreamMessageId || id === c.turnStreamMessageId) return;
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `non-streaming fallback ${id}`);
	}
	c.turnToolCallIds = [];
	if (assistantMsg.stop_reason) output.stopReason = mapStopReason(assistantMsg.stop_reason);
	debug(
		`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b) => b.type).join(",")}`,
	);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: output });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: output });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({
				type: "thinking",
				thinking: block.thinking ?? "",
				thinkingSignature: block.signature ?? "",
			});
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: output });
			if (block.thinking)
				c.currentPiStream?.push({
					type: "thinking_delta",
					contentIndex: idx,
					delta: block.thinking,
					partial: output,
				});
			c.currentPiStream?.push({
				type: "thinking_end",
				contentIndex: idx,
				content: block.thinking ?? "",
				partial: output,
			});
		} else if (block.type === "tool_use") {
			const piName = piToolNameFor(block.name, customToolNameToPi);
			if (!piName) {
				debug(
					`processAssistantMessage: skipping tool_use outside pi's MCP tools ${block.name} [${block.id}] — handled internally by CC`,
				);
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			const toolBlock: ToolCall = {
				type: "toolCall",
				id: block.id,
				name: piName,
				arguments: mapToolArgs(
					piName,
					block.input && typeof block.input === "object" && !Array.isArray(block.input)
						? (block.input as Record<string, unknown>)
						: undefined,
				),
			};
			c.turnBlocks.push(toolBlock);
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: output });
			c.currentPiStream?.push({
				type: "toolcall_end",
				contentIndex: idx,
				toolCall: toolBlock,
				partial: output,
			});
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage) recordUsage(output, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "toolUse";
		const stream = c.currentPiStream;
		stream.push({ type: "done", reason: "toolUse", message: deliveredMessage(c.turnOutput) });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;
	}
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
export async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<Api>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		// CLAUDE_BRIDGE_RECORD_STREAM=<path> appends every SDK message consumeQuery
		// sees, one JSON object per line, to capture replay fixtures, so unit tests
		// assert against message shapes Claude Code really emitted rather than ones we imagined.
		const recordStreamPath = process.env.CLAUDE_BRIDGE_RECORD_STREAM;
		if (recordStreamPath) appendFileSync(recordStreamPath, `${JSON.stringify(message)}\n`);
		if (wasAborted()) break;
		// Everything below the currentPiStream guard is content, which there is
		// nowhere to put once a turn has ended on a tool call. These three are not
		// content and must not share that gate:
		//
		// - stdin: nothing else closes the CLI's stdin now that the prompt is a
		//   streamed generator (isSingleUserTurn=false), so missing this hangs the query.
		// - the failure a `result` carries: it is the only record that the turn
		//   failed at all. Behind the guard, a 429 arriving at a tool boundary set
		//   no stopReason, no errorMessage, and logged nothing — the turn simply
		//   ended empty.
		// - rate-limit events: notifications to the user, which are most likely to
		//   fire during exactly the long tool-using turns the guard was skipping.
		let resultError: string | undefined;
		if (message.type === "result") {
			queryCtx.promptStream?.end();
			logServedContextWindow("result", message, model);
			resultError = resultErrorText(message);
			const rejection = queryCtx.rateLimitRejection;
			queryCtx.rateLimitRejection = null;
			if (resultError !== undefined) {
				// Consume the rejection alongside the failure it caused, so a later
				// unrelated failure on this query doesn't inherit the label.
				const quotaFailure = classifyAccountFailure(resultError, rejection);
				if (quotaFailure && queryCtx.accountProfile) queryCtx.quotaFailure = quotaFailure;
				const retryLabel = rejection ?? (queryCtx.accountProfile ? quotaFailure : null);
				if (retryLabel) resultError = describeRateLimitFailure(retryLabel, resultError);
				debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);
				if (queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "error";
					queryCtx.turnOutput.errorMessage = resultError;
				}
			}
		}
		if (message.type === "rate_limit_event") {
			const info = message.rate_limit_info;
			debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
			if (info?.status === "rejected") {
				// Held so the failure Claude Code sends next can be named as a rate limit.
				queryCtx.rateLimitRejection = info;
				// The "rate limited" notice below supersedes warnings; re-arm so the next
				// window's warnings fire even if it opens straight into allowed_warning.
				queryCtx.lastRateLimitWarnStep = null;
				queryCtx.lastRateLimitWarnThreshold = undefined;
				// resetsAt is Unix seconds, not milliseconds.
				const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "unknown";
				piUI?.notify(`Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
			} else if (info?.status === "allowed") {
				// Back under the threshold (window reset) — re-arm the warning dedupe.
				queryCtx.lastRateLimitWarnStep = null;
				queryCtx.lastRateLimitWarnThreshold = undefined;
			} else if (info?.status === "allowed_warning") {
				// utilization is a fraction (0..1); allowed_warning fires once it crosses surpassedThreshold.
				const percent = Math.round((info.utilization ?? 0) * 100);
				// The SDK emits one event per request, so only re-notify when the level
				// rises past a new 5% step or the threshold changes.
				const step = Math.floor(percent / 5);
				const rose = queryCtx.lastRateLimitWarnStep === null || step > queryCtx.lastRateLimitWarnStep;
				if (rose || info.surpassedThreshold !== queryCtx.lastRateLimitWarnThreshold) {
					queryCtx.lastRateLimitWarnStep = step;
					queryCtx.lastRateLimitWarnThreshold = info.surpassedThreshold;
					piUI?.notify(`Claude rate limit warning: ${percent}% used (${info.rateLimitType ?? ""})`, "warning");
				}
			}
			continue;
		}
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model, queryCtx);
				break;
			case "assistant":
				processAssistantMessage(message, model, customToolNameToPi, queryCtx);
				break;
			case "result": {
				// The failure itself was recorded above the guard, along with the served
				// context window. What is left here is the success path: push the result
				// text when no assistant message already delivered it.
				const textDelivered = queryCtx.turnSawStreamEvent || queryCtx.turnBlocks.some((b) => b.type === "text");
				if (resultError === undefined && !textDelivered && message.subtype === "success") {
					ensureTurnStarted(queryCtx);
					const text = message.result || "";
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({
						type: "text_delta",
						contentIndex: idx,
						delta: text,
						partial: queryCtx.turnOutput,
					});
					queryCtx.currentPiStream?.push({
						type: "text_end",
						contentIndex: idx,
						content: text,
						partial: queryCtx.turnOutput,
					});
				}
				break;
			}
			case "system":
				if (message.subtype === "init" && message.session_id) {
					capturedSessionId = message.session_id;
				}
				break;
			case "user":
				// SDK echo of the user prompt — no stream events to emit. Note it
				// carries only prompts and tool results: a steer CC drained at a
				// tool boundary is recorded in its session transcript as a
				// `queued_command` attachment and never reaches this stream, which
				// is why the mid-turn steering tripwire has to live in the
				// integration test.
				break;
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	// DEBUG: trace when consumeQuery exits
	debug(
		`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`,
	);

	return { capturedSessionId };
}
