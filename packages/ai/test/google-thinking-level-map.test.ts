import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleGoogleGenerativeAi } from "../src/api/google-generative-ai.ts";
import { streamSimple as streamSimpleGoogleVertex } from "../src/api/google-vertex.ts";
import type { Context, Model, ThinkingLevelMap } from "../src/types.ts";

type CapturedPayload = { config?: { thinkingConfig?: { thinkingLevel?: string } } };

function makeModel<TApi extends "google-generative-ai" | "google-vertex">(
	api: TApi,
	thinkingLevelMap: ThinkingLevelMap,
): Model<TApi> {
	return {
		id: "gemini-3-flash-preview",
		name: "gemini-3-flash-preview",
		api,
		provider: api === "google-generative-ai" ? "google" : "google-vertex",
		baseUrl:
			api === "google-generative-ai"
				? "https://generativelanguage.googleapis.com/v1beta"
				: "https://us-central1-aiplatform.googleapis.com",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	};
}

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };

async function captureThinkingLevel(
	api: "google-generative-ai" | "google-vertex",
	thinkingLevelMap: ThinkingLevelMap,
): Promise<string | undefined> {
	let captured: CapturedPayload | undefined;
	const options = {
		apiKey: "fake-key",
		reasoning: "low" as const,
		onPayload: (payload: unknown) => {
			captured = payload as CapturedPayload;
			throw new Error("payload captured");
		},
	};
	const stream =
		api === "google-generative-ai"
			? streamSimpleGoogleGenerativeAi(makeModel(api, thinkingLevelMap), context, options)
			: streamSimpleGoogleVertex(makeModel(api, thinkingLevelMap), context, options);
	await stream.result();
	if (!captured) throw new Error(`Expected ${api} payload to be captured`);
	return captured.config?.thinkingConfig?.thinkingLevel;
}

describe("Google thinkingLevelMap string values", () => {
	it.each(["google-generative-ai", "google-vertex"] as const)("sends the mapped level on %s", async (api) => {
		expect(await captureThinkingLevel(api, {})).toBe("LOW");
		expect(await captureThinkingLevel(api, { low: "HIGH" })).toBe("HIGH");
		expect(await captureThinkingLevel(api, { low: "medium" })).toBe("MEDIUM");
	});
});
