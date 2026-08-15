import { describe, expect, it } from "vitest";
import { stream as streamGoogleGenerativeAi } from "../src/api/google-generative-ai.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import type { Context, Model } from "../src/types.ts";

type CapturedPayload = {
	config?: {
		maxOutputTokens?: number;
	};
};

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeGoogleAiModel(): Model<"google-generative-ai"> {
	return {
		id: "gemini-flash-latest",
		name: "Gemini Flash Latest",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
	};
}

function makeVertexModel(): Model<"google-vertex"> {
	return {
		id: "gemini-flash-latest",
		name: "Gemini Flash Latest",
		api: "google-vertex",
		provider: "google-vertex",
		baseUrl: "https://us-central1-aiplatform.googleapis.com",
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

async function captureGoogleAiPayload(maxTokens: number): Promise<CapturedPayload> {
	let capturedPayload: CapturedPayload | undefined;
	const request = streamGoogleGenerativeAi(makeGoogleAiModel(), makeContext(), {
		apiKey: "fake-key",
		maxTokens,
		onPayload: (payload) => {
			capturedPayload = payload as CapturedPayload;
			throw new PayloadCaptured();
		},
	});

	await request.result();
	if (!capturedPayload) {
		throw new Error("Expected Google Generative AI payload to be captured");
	}
	return capturedPayload;
}

async function captureVertexPayload(maxTokens: number): Promise<CapturedPayload> {
	let capturedPayload: CapturedPayload | undefined;
	const request = streamGoogleVertex(makeVertexModel(), makeContext(), {
		apiKey: "fake-key",
		maxTokens,
		onPayload: (payload) => {
			capturedPayload = payload as CapturedPayload;
			throw new PayloadCaptured();
		},
	});

	await request.result();
	if (!capturedPayload) {
		throw new Error("Expected Google Vertex payload to be captured");
	}
	return capturedPayload;
}

describe("Google max output tokens payload", () => {
	it("clamps the Google Generative AI exclusive boundary and preserves smaller values", async () => {
		expect((await captureGoogleAiPayload(65536)).config?.maxOutputTokens).toBe(65535);
		expect((await captureGoogleAiPayload(65534)).config?.maxOutputTokens).toBe(65534);
	});

	it("clamps the Google Vertex exclusive boundary and preserves smaller values", async () => {
		expect((await captureVertexPayload(65536)).config?.maxOutputTokens).toBe(65535);
		expect((await captureVertexPayload(65534)).config?.maxOutputTokens).toBe(65534);
	});
});
