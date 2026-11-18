import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: () => {
				const failure = Promise.reject(Object.assign(new Error("Insufficient credits"), { status: 402 }));
				return Object.assign(failure, { withResponse: () => failure });
			},
		};
	}
	return { default: FakeOpenAI };
});

function createModel(provider: string): Model<"openai-responses"> {
	return {
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		api: "openai-responses",
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

const context: Context = { systemPrompt: "Test", messages: [{ role: "user", content: "Test", timestamp: 1 }] };

// Upstream #9298: every Responses provider's HTTP errors were labelled "OpenAI API error".
describe("openai-responses error provider label", () => {
	it.each([
		["openai", "OpenAI API error (402): Insufficient credits"],
		["openrouter", "openrouter API error (402): Insufficient credits"],
	])("names provider %s in the error message", async (provider, expected) => {
		const result = await streamOpenAIResponses(createModel(provider), context, { apiKey: "test-key" }).result();

		expect(result.errorMessage).toBe(expected);
	});
});
