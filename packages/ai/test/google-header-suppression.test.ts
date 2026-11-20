import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import type { Model } from "../src/types.ts";

const model: Model<"google-generative-ai"> = {
	id: "gemini-3-flash-preview",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://example.invalid/v1beta",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 65536,
	headers: { "X-Trace-Id": "model-default" },
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Google request headers", () => {
	it("suppresses a model default header when the caller passes null with different casing", async () => {
		const sent: Headers[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			sent.push(new Headers(init?.headers));
			return new Response("{}", { status: 500 });
		});

		await streamGoogle(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{ apiKey: "fake-key", headers: { "x-trace-id": null } },
		).result();

		expect(sent.length).toBeGreaterThan(0);
		expect(sent.map((headers) => headers.get("x-trace-id"))).toEqual(sent.map(() => null));
	});
});
