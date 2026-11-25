import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	type Api,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIsolatedSummary, setIsolatedQueryImpl } from "../extensions/claude-bridge/src/isolated-summary.ts";
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

let tempDir: string | undefined;

afterEach(() => {
	setIsolatedQueryImpl(null);
	vi.unstubAllEnvs();
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

async function* quotaRejectedQuery(resetsAt: number): AsyncGenerator<SDKMessage> {
	yield {
		type: "rate_limit_event",
		rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt },
	} as unknown as SDKMessage;
	yield {
		type: "result",
		subtype: "success",
		is_error: true,
		result: "You've hit your session limit · resets 12:40pm (America/Chicago)",
	} as unknown as SDKMessage;
	throw new Error("Claude Code returned an error result after the quota rejection");
}

function streamEvent(event: Record<string, unknown>): SDKMessage {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: null,
		uuid: "u",
		session_id: "s",
	} as unknown as SDKMessage;
}

/** One assistant turn that ends on a wait_agent call, then Claude Code reports a failed result
 *  while the call is parked at the tool boundary. */
async function* toolTurnThenFailedResult(): AsyncGenerator<SDKMessage> {
	yield streamEvent({ type: "message_start", message: { id: "msg_1" } });
	yield streamEvent({
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: "toolu_wait", name: "mcp__custom-tools__wait_agent", input: {} },
	});
	yield streamEvent({
		type: "content_block_delta",
		index: 0,
		delta: { type: "input_json_delta", partial_json: "{}" },
	});
	yield streamEvent({ type: "content_block_stop", index: 0 });
	yield streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } });
	yield streamEvent({ type: "message_stop" });
	yield {
		type: "result",
		subtype: "success",
		is_error: true,
		result: "API Error: Connection reset",
	} as unknown as SDKMessage;
}

describe("Claude bridge delivered messages", () => {
	it("sets retryAfterMs from rejected quota reset times on provider and summary errors", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-claude-retry-after-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(tempDir, "agent"));

		for (const delayMs of [5 * 60 * 60 * 1000, 5_000]) {
			const resetsAt = (Date.now() + delayMs) / 1000;
			const expectedDelayMs = resetsAt * 1000 - Date.now();

			const queryCtx = new QueryContext();
			queryCtx.resetTurnState(model);
			const providerStream = createAssistantMessageEventStream();
			claimCurrentPiStream(providerStream, "retry-after-test", queryCtx);
			await expect(
				consumeQuery(
					quotaRejectedQuery(resetsAt) as unknown as ReturnType<typeof query>,
					new Map(),
					model,
					() => false,
					queryCtx,
				),
			).rejects.toThrow("Claude Code returned an error result after the quota rejection");
			finalizeCurrentStream(queryCtx, "error");
			const providerError = await providerStream.result();

			expect(providerError.stopReason).toBe("error");
			expect(providerError.retryAfterMs).toBeDefined();
			expect(Math.abs((providerError.retryAfterMs ?? 0) - expectedDelayMs)).toBeLessThan(100);

			const isolatedStream = createAssistantMessageEventStream();
			const sdkQuery = Object.assign(quotaRejectedQuery(resetsAt), { interrupt: async () => {}, close: () => {} });
			setIsolatedQueryImpl((() => sdkQuery) as never);
			await runIsolatedSummary(
				model,
				{
					messages: [{ role: "user", content: "Summarize this text.", timestamp: Date.now() }],
				} as Context,
				{ cwd: tempDir } as SimpleStreamOptions,
				isolatedStream,
			);
			const summaryError = await isolatedStream.result();

			expect(summaryError.stopReason).toBe("error");
			expect(summaryError.retryAfterMs).toBeDefined();
			expect(Math.abs((summaryError.retryAfterMs ?? 0) - expectedDelayMs)).toBeLessThan(100);
		}
	});

	it("keeps a delivered tool-use turn unchanged when the query fails at the tool boundary", async () => {
		const queryCtx = new QueryContext();
		queryCtx.resetTurnState(model);
		const stream = createAssistantMessageEventStream();
		claimCurrentPiStream(stream, "test", queryCtx);

		await consumeQuery(
			toolTurnThenFailedResult() as unknown as ReturnType<typeof query>,
			new Map([["mcp__custom-tools__wait_agent", "wait_agent"]]),
			model,
			() => false,
			queryCtx,
		);
		const delivered = await stream.result();

		// The query itself records the failure on its own turn state.
		expect(queryCtx.turnOutput?.stopReason).toBe("error");
		// Pi already stored the tool-use turn; it must stay a tool-use turn, or the next
		// request drops it and sends its tool result without the call.
		expect(delivered.stopReason).toBe("toolUse");
		expect(delivered.errorMessage).toBeUndefined();
		expect(delivered.content).toEqual([{ type: "toolCall", id: "toolu_wait", name: "wait_agent", arguments: {} }]);
	});
});
