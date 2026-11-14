import type * as GoogleSdk from "@google/genai";
import { FinishReason, type GenerateContentResponse } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import type { Context, Model, StopReason } from "../src/types.ts";

const sdkStream = vi.hoisted(() => ({
	chunks: [] as Pick<GenerateContentResponse, "candidates">[],
}));

vi.mock("@google/genai", async (importOriginal) => {
	const sdk = await importOriginal<typeof GoogleSdk>();
	return {
		...sdk,
		GoogleGenAI: class {
			models = {
				async *generateContentStream() {
					yield* sdkStream.chunks;
				},
			};
		},
	};
});

function makeModel<T extends "google-generative-ai" | "google-vertex">(api: T): Model<T> {
	return {
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash",
		api,
		provider: api === "google-vertex" ? "google-vertex" : "google",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	};
}

const context: Context = {
	messages: [{ role: "user", content: "Read a.txt", timestamp: 0 }],
};

const providers = [
	{
		api: "google-generative-ai",
		stream: () => streamGoogle(makeModel("google-generative-ai"), context, { apiKey: "fake-key" }),
	},
	{
		api: "google-vertex",
		stream: () => streamVertex(makeModel("google-vertex"), context, { apiKey: "fake-key" }),
	},
];

const finishReasons: { finishReason: FinishReason; stopReason: StopReason }[] = [
	{ finishReason: FinishReason.SAFETY, stopReason: "error" },
	{ finishReason: FinishReason.BLOCKLIST, stopReason: "error" },
	{ finishReason: FinishReason.MALFORMED_FUNCTION_CALL, stopReason: "error" },
	{ finishReason: FinishReason.OTHER, stopReason: "error" },
	{ finishReason: FinishReason.MAX_TOKENS, stopReason: "length" },
	{ finishReason: FinishReason.STOP, stopReason: "toolUse" },
];

describe.each(providers)("$api streamed responses", ({ stream }) => {
	it.each(finishReasons)("preserves $finishReason after a function call", async ({ finishReason, stopReason }) => {
		sdkStream.chunks = [
			{ candidates: [{ content: { parts: [{ functionCall: { name: "read", args: { path: "a.txt" } } }] } }] },
			{ candidates: [{ finishReason }] },
		];

		const response = stream();
		const eventTypes: string[] = [];
		for await (const event of response) eventTypes.push(event.type);
		const message = await response.result();

		expect(message.content).toEqual([
			{ type: "toolCall", id: expect.any(String), name: "read", arguments: { path: "a.txt" } },
		]);
		expect(message.stopReason).toBe(stopReason);
		if (stopReason === "error") {
			expect(message.errorMessage).toBe("An unknown error occurred");
			expect(eventTypes.at(-1)).toBe("error");
			expect(eventTypes).not.toContain("done");
		} else {
			expect(message.errorMessage).toBeUndefined();
			expect(eventTypes.at(-1)).toBe("done");
		}
	});
});
