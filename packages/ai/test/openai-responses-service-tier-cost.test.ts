import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openai-responses service tier pricing", () => {
	it.each([
		["priority", "priority", 2],
		["flex", "flex", 0.5],
		// GPT-6 models report Fast mode as "fast" even when "priority" is requested (#10034)
		["priority", "fast", 2],
	] as const)(
		"applies the cost multiplier for requested %s and returned %s",
		async (serviceTier, returned, multiplier) => {
			const model = getModel("openai", "gpt-5.4");
			const tokenCount = 100_000;
			const tokenScale = tokenCount / 1_000_000;
			const event = {
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: returned,
					usage: {
						input_tokens: tokenCount,
						output_tokens: tokenCount,
						total_tokens: tokenCount * 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			};
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(`data: ${JSON.stringify(event)}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const result = await streamOpenAIResponses(
				model,
				{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{ apiKey: "test-key", serviceTier },
			).result();

			expect(result.usage.cost.total).toBeCloseTo(
				(model.cost.input + model.cost.output) * multiplier * tokenScale,
				12,
			);
		},
	);
});
