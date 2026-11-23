import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

async function streamWithUsage(usage: Record<string, unknown>) {
	const chunks = [
		{
			id: "gen-1",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
		},
		{
			id: "gen-1",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage,
		},
	];
	const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
	);
	return streamSimple(
		getModel("openrouter", "deepseek/deepseek-r1-0528"),
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test" },
	).result();
}

const tokens = { prompt_tokens: 1000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 } };

describe("OpenRouter reported cost", () => {
	it("uses OpenRouter's billed cost for non-BYOK requests", async () => {
		const result = await streamWithUsage({
			...tokens,
			cost: 0.004,
			is_byok: false,
			cost_details: { upstream_inference_cost: null },
		});

		expect(result.usage.cost.total).toBe(0.004);
	});

	it("adds the upstream inference cost for BYOK requests", async () => {
		const result = await streamWithUsage({
			...tokens,
			cost: 0.0002,
			is_byok: true,
			cost_details: { upstream_inference_cost: 0.003 },
		});

		expect(result.usage.cost.total).toBeCloseTo(0.0032, 12);
	});

	it("keeps the catalog estimate when OpenRouter accounting is missing", async () => {
		const result = await streamWithUsage(tokens);

		expect(result.usage.cost.total).toBeCloseTo(result.usage.cost.input + result.usage.cost.output, 12);
		expect(result.usage.cost.total).toBeGreaterThan(0);
	});
});
