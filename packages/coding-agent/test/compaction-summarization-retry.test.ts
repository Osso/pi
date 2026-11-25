import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retryTransientSummarization } from "../src/core/compaction/summarization-retry.ts";

function unavailable(retryAfterMs?: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "503 Service Unavailable",
		retryAfterMs,
		timestamp: Date.now(),
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("compaction summarization retry", () => {
	it("waits for the provider retry delay before repeating a transient failure", async () => {
		vi.useFakeTimers();
		const request = vi.fn(async () => unavailable(30_000));

		const result = retryTransientSummarization(request, undefined);
		await vi.advanceTimersByTimeAsync(29_000);
		expect(request).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(request).toHaveBeenCalledTimes(2);

		await vi.runAllTimersAsync();
		await result;
	});

	it("keeps the scheduled backoff when the provider gives no retry delay", async () => {
		vi.useFakeTimers();
		const request = vi.fn(async () => unavailable());

		const result = retryTransientSummarization(request, undefined);
		await vi.advanceTimersByTimeAsync(2_500);
		expect(request).toHaveBeenCalledTimes(2);

		await vi.runAllTimersAsync();
		await result;
		expect(request).toHaveBeenCalledTimes(4);
	});
});
