import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type Api, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { QueryContext } from "../extensions/claude-bridge/src/query-state.ts";
import {
	claimCurrentPiStream,
	consumeQuery,
	finalizeCurrentStream,
} from "../extensions/claude-bridge/src/stream-events.ts";

const model: Model<Api> = {
	id: "claude-opus-5-5",
	name: "Claude Opus",
	api: "claude-bridge",
	provider: "claude-bridge",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
};

function streamEvent(event: Record<string, unknown>): SDKMessage {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: null,
		uuid: "u",
		session_id: "s",
	} as unknown as SDKMessage;
}

/** A turn whose thinking and text blocks carry their first content in content_block_start. */
async function* turnWithContentInBlockStart(): AsyncGenerator<SDKMessage> {
	yield streamEvent({ type: "message_start", message: { id: "msg_1" } });
	yield streamEvent({
		type: "content_block_start",
		index: 0,
		content_block: { type: "thinking", thinking: "Initial thinking", signature: "initial signature" },
	});
	yield streamEvent({
		type: "content_block_delta",
		index: 0,
		delta: { type: "thinking_delta", thinking: " plus delta" },
	});
	yield streamEvent({
		type: "content_block_delta",
		index: 0,
		delta: { type: "signature_delta", signature: " plus delta" },
	});
	yield streamEvent({ type: "content_block_stop", index: 0 });
	yield streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "Initial text" } });
	yield streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " plus delta" } });
	yield streamEvent({ type: "content_block_stop", index: 1 });
	yield streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } });
	yield streamEvent({ type: "message_stop" });
	yield {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "Initial text plus delta",
	} as unknown as SDKMessage;
}

describe("Claude bridge content_block_start", () => {
	it("keeps text and thinking sent in content_block_start", async () => {
		const queryCtx = new QueryContext();
		queryCtx.resetTurnState(model);
		const stream = createAssistantMessageEventStream();
		claimCurrentPiStream(stream, "test", queryCtx);

		await consumeQuery(
			turnWithContentInBlockStart() as unknown as ReturnType<typeof query>,
			new Map(),
			model,
			() => false,
			queryCtx,
		);
		// The query runner closes the turn after the query ends (fresh-query.ts).
		finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		const delivered = await stream.result();

		expect(delivered.content).toEqual([
			{
				type: "thinking",
				thinking: "Initial thinking plus delta",
				thinkingSignature: "initial signature plus delta",
			},
			{ type: "text", text: "Initial text plus delta" },
		]);
	});
});
