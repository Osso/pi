import type * as GoogleSdk from "@google/genai";
import { BlockedReason, FinishReason, type GenerateContentResponse, type Part } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { convertMessages } from "../src/api/google-shared.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import type { Context, Model, StopReason } from "../src/types.ts";

const sdkStream = vi.hoisted(() => ({
	chunks: [] as Pick<GenerateContentResponse, "candidates" | "promptFeedback">[],
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
		api: "google-generative-ai" as const,
		stream: () => streamGoogle(makeModel("google-generative-ai"), context, { apiKey: "fake-key" }),
	},
	{
		api: "google-vertex" as const,
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

const textParts: { name: string; parts: Part[] }[] = [
	{ name: "unsigned then signed", parts: [{ text: "First" }, { text: "Second", thoughtSignature: "QkJC" }] },
	{ name: "signed then unsigned", parts: [{ text: "First", thoughtSignature: "QUFB" }, { text: "Second" }] },
	{
		name: "two signed parts",
		parts: [
			{ text: "First", thoughtSignature: "QUFB" },
			{ text: "Second", thoughtSignature: "QkJC" },
		],
	},
];

describe.each(providers)("$api streamed responses", ({ api, stream }) => {
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

	it("reports a blocked prompt as an error", async () => {
		sdkStream.chunks = [{ promptFeedback: { blockReason: BlockedReason.SAFETY }, candidates: [] }];

		const response = stream();
		const eventTypes: string[] = [];
		for await (const event of response) eventTypes.push(event.type);
		const message = await response.result();

		expect(eventTypes).toEqual(["start", "error"]);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Prompt blocked: SAFETY");
	});

	it.each(textParts)("preserves $name during streaming and replay", async ({ parts }) => {
		sdkStream.chunks = [{ candidates: [{ content: { parts }, finishReason: FinishReason.STOP }] }];
		const response = stream();
		const textEnds: string[] = [];
		for await (const event of response) {
			if (event.type === "text_end") textEnds.push(event.content);
		}
		const message = await response.result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual(
			parts.map((part) => ({ type: "text", text: part.text, textSignature: part.thoughtSignature })),
		);
		expect(textEnds).toEqual(parts.map((part) => part.text));
		expect(convertMessages(makeModel(api), { messages: [message] })).toEqual([{ role: "model", parts }]);
	});

	it("keeps two signed thinking parts of one chunk apart during streaming and replay", async () => {
		const parts: Part[] = [
			{ thought: true, text: "First", thoughtSignature: "QUFB" },
			{ thought: true, text: "Second", thoughtSignature: "QkJC" },
		];
		sdkStream.chunks = [{ candidates: [{ content: { parts }, finishReason: FinishReason.STOP }] }];
		const message = await stream().result();

		expect(message.content).toEqual([
			{ type: "thinking", thinking: "First", thinkingSignature: "QUFB" },
			{ type: "thinking", thinking: "Second", thinkingSignature: "QkJC" },
		]);
		expect(convertMessages(makeModel(api), { messages: [message] })).toEqual([{ role: "model", parts }]);
	});

	it("merges a signature-bearing delta from a later chunk into the current text part", async () => {
		sdkStream.chunks = [
			{ candidates: [{ content: { parts: [{ text: "First" }] } }] },
			{
				candidates: [
					{ content: { parts: [{ text: "Second", thoughtSignature: "QkJC" }] }, finishReason: FinishReason.STOP },
				],
			},
		];
		const message = await stream().result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "FirstSecond", textSignature: "QkJC" }]);
	});

	it.each([undefined, "QUFB"])("merges deltas of one text part across chunks with signature %s", async (signature) => {
		sdkStream.chunks = [
			{ candidates: [{ content: { parts: [{ text: "First", thoughtSignature: signature }] } }] },
			{ candidates: [{ content: { parts: [{ text: "Second" }] }, finishReason: FinishReason.STOP }] },
		];
		const message = await stream().result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "FirstSecond", textSignature: signature }]);
		expect(convertMessages(makeModel(api), { messages: [message] })).toEqual([
			{ role: "model", parts: [{ text: "FirstSecond", ...(signature && { thoughtSignature: signature }) }] },
		]);
	});
});
