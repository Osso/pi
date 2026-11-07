import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({ lastParams: undefined as Record<string, unknown> | undefined }));

vi.mock("openai", () => {
	async function* createCompletedStream(): AsyncIterable<ResponseStreamEvent> {
		yield {
			type: "response.created",
			sequence_number: 0,
			response: { id: "resp_test" },
		} as ResponseStreamEvent;
		yield {
			type: "response.completed",
			sequence_number: 1,
			response: {
				id: "resp_test",
				output: [],
				usage: {
					input_tokens: 1,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 1,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 2,
				},
			},
		} as unknown as ResponseStreamEvent;
	}

	class FakeOpenAI {
		responses = {
			create: (params: Record<string, unknown>) => {
				mockState.lastParams = params;
				const responseStream = createCompletedStream();
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

function createModel(compat?: Model<"openai-responses">["compat"]): Model<"openai-responses"> {
	return {
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-responses",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		compat,
	};
}

function createContext(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
}

async function runStream(model: Model<"openai-responses">): Promise<void> {
	const stream = streamOpenAIResponses(model, createContext(), { apiKey: "test-key" });
	for await (const _event of stream) {
		// Drain the stream; the assertion targets the outgoing request body.
	}
}

describe("OpenAI Responses OpenRouter routing", () => {
	it("forwards compat.openRouterRouting as the request provider field", async () => {
		await runStream(createModel({ openRouterRouting: { zdr: true } }));
		expect(mockState.lastParams?.provider).toEqual({ zdr: true });
	});

	it("omits the provider field when no OpenRouter routing is configured", async () => {
		await runStream(createModel());
		expect(mockState.lastParams?.provider).toBeUndefined();
	});
});
