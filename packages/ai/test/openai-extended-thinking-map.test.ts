import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Api, Model, ThinkingLevel } from "../src/types.ts";

// Mirrors a models.json entry: the endpoint accepts native `max`, and `ultra` maps onto it.
const thinkingLevelMap = { minimal: "low", xhigh: "xhigh", max: "max", ultra: "max" };

function model<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		api,
		provider: "proxy",
		baseUrl: "https://proxy.invalid/v1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

async function sentBody(target: Model<Api>, reasoning: ThinkingLevel): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> = {};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
	});
	const events = streamSimple(
		target,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test-key", reasoning, maxRetries: 0 },
	);
	for await (const event of events) {
		if (event.type === "done" || event.type === "error") break;
	}
	return body;
}

describe("extended thinking levels with a model thinkingLevelMap", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		["max", "max"],
		["ultra", "max"],
		["xhigh", "xhigh"],
		["high", "high"],
	] as const)("openai-responses sends %s as effort %s", async (level, effort) => {
		const body = await sentBody(model("openai-responses"), level);
		expect(body.reasoning).toMatchObject({ effort });
	});

	it.each([
		["max", "max"],
		["ultra", "max"],
		["high", "high"],
	] as const)("openai-completions sends %s as reasoning_effort %s", async (level, effort) => {
		const body = await sentBody(model("openai-completions"), level);
		expect(body.reasoning_effort).toBe(effort);
	});
});
