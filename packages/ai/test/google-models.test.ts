import { describe, expect, it } from "vitest";
import { getModels } from "../src/compat.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { KnownProvider } from "../src/types.ts";

interface GoogleProviderExpectation {
	provider: Extract<KnownProvider, "google" | "google-vertex">;
	api: "google-generative-ai" | "google-vertex";
	baseUrl: string;
}

const GOOGLE_PROVIDERS: GoogleProviderExpectation[] = [
	{
		provider: "google",
		api: "google-generative-ai",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	},
	{
		provider: "google-vertex",
		api: "google-vertex",
		baseUrl: "https://{location}-aiplatform.googleapis.com",
	},
];

describe("Google model metadata", () => {
	it.each(GOOGLE_PROVIDERS)("registers Gemini 3.7 Flash for $provider", ({ provider, api, baseUrl }) => {
		const model = getModels(provider).find((candidate) => candidate.id === "gemini-3.7-flash");
		expect(model).toBeDefined();
		if (!model) {
			throw new Error(`Missing gemini-3.7-flash for ${provider}`);
		}

		expect(model).toMatchObject({
			id: "gemini-3.7-flash",
			name: "Gemini 3.7 Flash",
			api,
			provider,
			baseUrl,
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null },
			input: ["text", "image"],
			cost: {
				input: 0.75,
				output: 3.75,
				cacheRead: 0.075,
				cacheWrite: 0,
			},
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high"]);
	});
});
