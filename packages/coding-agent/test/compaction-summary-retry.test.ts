import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSummary } from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
	return { ...actual, completeSimple: completeSimpleMock };
});

const model: Model<"openai-responses"> = {
	id: "gpt-6.2-sol",
	name: "GPT 6.2 Sol",
	api: "openai-responses",
	provider: "proxy",
	baseUrl: "http://proxy.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

function response(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "proxy",
		model: "gpt-6.2-sol",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

// The error a dropped proxy connection produced in session 01a0ea1a (2026-11-18).
const CONNECTION_RESET = response({
	stopReason: "error",
	errorMessage:
		"ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch().",
});
const SUMMARY = response({ content: [{ type: "text", text: "## Goal\nKeep working" }] });
const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("compaction summary retry", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	it("repeats the request after a dropped connection and returns the summary", async () => {
		completeSimpleMock.mockResolvedValueOnce(CONNECTION_RESET).mockResolvedValueOnce(SUMMARY);

		const summary = generateSummary(messages, model, 2000, "key");
		await vi.runAllTimersAsync();

		await expect(summary).resolves.toBe("## Goal\nKeep working");
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
	});

	it("fails after the bounded number of repeats", async () => {
		completeSimpleMock.mockResolvedValue(CONNECTION_RESET);

		const summary = expect(generateSummary(messages, model, 2000, "key")).rejects.toThrow(
			"Summarization failed: ECONNRESET",
		);
		await vi.runAllTimersAsync();

		await summary;
		expect(completeSimpleMock).toHaveBeenCalledTimes(4);
	});

	it.each([
		["a rate limit", "429 Too Many Requests: rate limit reached"],
		["a deterministic error", "400 invalid_request_error: unsupported parameter"],
	])("does not repeat %s", async (_name, errorMessage) => {
		completeSimpleMock.mockResolvedValue(response({ stopReason: "error", errorMessage }));

		const summary = expect(generateSummary(messages, model, 2000, "key")).rejects.toThrow("Summarization failed");
		await vi.runAllTimersAsync();

		await summary;
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("stops repeating when the compaction is cancelled", async () => {
		completeSimpleMock.mockResolvedValue(CONNECTION_RESET);
		const controller = new AbortController();

		const summary = expect(
			generateSummary(messages, model, 2000, "key", undefined, controller.signal),
		).rejects.toThrow("Summarization failed");
		controller.abort();
		await vi.runAllTimersAsync();

		await summary;
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});
});
