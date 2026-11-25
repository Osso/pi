import type * as GoogleSdk from "@google/genai";
import { ApiError } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import type { Context, Model } from "../src/types.ts";

const sdkStream = vi.hoisted(() => ({
	error: undefined as unknown,
}));

vi.mock("@google/genai", async (importOriginal) => {
	const sdk = await importOriginal<typeof GoogleSdk>();
	return {
		...sdk,
		GoogleGenAI: class {
			models = {
				async generateContentStream() {
					throw sdkStream.error;
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
	messages: [{ role: "user", content: "Test", timestamp: 0 }],
};

const providers = [
	{
		api: "google-generative-ai" as const,
		stream: () => streamGoogle(makeModel("google-generative-ai"), context, { apiKey: "fake-key" }),
	},
	{
		api: "google-vertex" as const,
		stream: () => streamVertex(makeModel("google-vertex"), context, { apiKey: "fake-key" }),
	},
];

const retryErrors = [
	{
		name: "Google RetryInfo duration in the JSON error body",
		message: JSON.stringify({
			error: {
				code: 429,
				status: "RESOURCE_EXHAUSTED",
				details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "120.500s" }],
			},
		}),
		retryAfterMs: 120_500,
	},
	{
		name: "retry delay in prose",
		message: "Please try again in 2m4s.",
		retryAfterMs: 124_000,
	},
	{
		name: "fractional retry delay in Google prose",
		message: "Please retry in 41.297487613s.",
		retryAfterMs: 41_297,
	},
	{
		name: "error without a retry delay",
		message: "Quota exceeded.",
		retryAfterMs: undefined,
	},
];

describe.each(providers)("$api retry metadata", ({ stream }) => {
	it.each(retryErrors)("records $name on the failed assistant message", async ({ message, retryAfterMs }) => {
		sdkStream.error = new ApiError({ status: 429, message });

		const response = stream();
		const result = await response.result();

		expect(result.stopReason).toBe("error");
		expect(result.retryAfterMs).toBe(retryAfterMs);
	});
});
