import { describe, expect, it } from "vitest";
import { stream as streamGoogleGenerativeAi } from "../src/api/google-generative-ai.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import type { Context, Model } from "../src/types.ts";

type CapturedPayload = {
	config?: {
		thinkingConfig?: {
			includeThoughts?: boolean;
			thinkingLevel?: string;
		};
	};
};

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeModel<TApi extends "google-generative-ai" | "google-vertex">(api: TApi, id: string): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider: api === "google-generative-ai" ? "google" : "google-vertex",
		baseUrl:
			api === "google-generative-ai"
				? "https://generativelanguage.googleapis.com/v1beta"
				: "https://us-central1-aiplatform.googleapis.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	};
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

type ThinkingOptions = { enabled: boolean; level?: "LOW" };

async function captureGoogleAiPayload(modelId: string, thinking: ThinkingOptions): Promise<CapturedPayload> {
	let capturedPayload: CapturedPayload | undefined;
	const stream = streamGoogleGenerativeAi(makeModel("google-generative-ai", modelId), makeContext(), {
		apiKey: "fake-key",
		thinking,
		onPayload: (payload) => {
			capturedPayload = payload as CapturedPayload;
			throw new PayloadCaptured();
		},
	});

	await stream.result();
	if (!capturedPayload) {
		throw new Error("Expected Google Generative AI payload to be captured");
	}
	return capturedPayload;
}

async function captureVertexPayload(modelId: string, thinking: ThinkingOptions): Promise<CapturedPayload> {
	let capturedPayload: CapturedPayload | undefined;
	const stream = streamGoogleVertex(makeModel("google-vertex", modelId), makeContext(), {
		apiKey: "fake-key",
		thinking,
		onPayload: (payload) => {
			capturedPayload = payload as CapturedPayload;
			throw new PayloadCaptured();
		},
	});

	await stream.result();
	if (!capturedPayload) {
		throw new Error("Expected Google Vertex payload to be captured");
	}
	return capturedPayload;
}

async function capturePayload(
	api: "google-generative-ai" | "google-vertex",
	modelId: string,
	thinking: ThinkingOptions,
): Promise<CapturedPayload> {
	return api === "google-generative-ai"
		? captureGoogleAiPayload(modelId, thinking)
		: captureVertexPayload(modelId, thinking);
}

describe("Gemini latest thinking config", () => {
	it.each(["google-generative-ai", "google-vertex"] as const)(
		"omits thinkingConfig for %s when thinking is disabled",
		async (api) => {
			const payload = await capturePayload(api, "gemini-flash-latest", { enabled: false });

			expect(payload.config?.thinkingConfig).toBeUndefined();
		},
	);

	it.each(["google-generative-ai", "google-vertex"] as const)(
		"omits thinkingConfig for %s when low thinking is requested",
		async (api) => {
			const payload = await capturePayload(api, "gemini-flash-latest", { enabled: true, level: "LOW" });

			expect(payload.config?.thinkingConfig).toBeUndefined();
		},
	);

	it.each(["google-generative-ai", "google-vertex"] as const)(
		"keeps LOW thinking config for explicit Gemini 3.7 Flash on %s",
		async (api) => {
			const payload = await capturePayload(api, "gemini-3.7-flash", { enabled: false });

			expect(payload.config?.thinkingConfig?.thinkingLevel).toBe("LOW");
		},
	);
});
