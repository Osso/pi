import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.ts";

vi.mock("openai", () => {
	async function* createRateLimitedStream(): AsyncIterable<ResponseStreamEvent> {
		yield {
			type: "response.created",
			sequence_number: 0,
			response: { id: "resp_rate_limited" },
		} as ResponseStreamEvent;
		yield {
			type: "error",
			sequence_number: 1,
			code: "rate_limit_exceeded",
			message:
				"Rate limit reached for gpt-6-luna in organization org-test on tokens per min (TPM): Limit 100000, Used 93334, Requested 26472. Please try again in 142h36m11.52s.",
			param: null,
		} as ResponseStreamEvent;
	}

	class FakeOpenAI {
		responses = {
			create: () => {
				const responseStream = createRateLimitedStream();
				const promise = Promise.resolve(responseStream) as Promise<AsyncIterable<ResponseStreamEvent>> & {
					withResponse: () => Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: responseStream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function createContext(): Context {
	return {
		systemPrompt: "Test",
		messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
	};
}

describe("openai-responses streamed rate limit", () => {
	it("keeps the delay stated in a stream error event, which has no HTTP headers", async () => {
		const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);

		const errorEvent = events.find((event) => event.type === "error");
		expect(errorEvent).toBeDefined();
		const message = (errorEvent as { error: AssistantMessage }).error;
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Please try again in 142h36m11.52s");
		expect(message.retryAfterMs).toBe(142 * 3_600_000 + 36 * 60_000 + 11_520);
	});
});
