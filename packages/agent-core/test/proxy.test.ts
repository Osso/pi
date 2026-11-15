import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.ts";

const testModel: Model<Api> = {
	id: "gpt-4o-mini",
	name: "GPT-4o Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

const emptyUsage: Usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("streamProxy", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("flushes a trailing SSE line without newline and ignores [DONE]", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sseResponse([
					'data: {"type":"start"}\r\n',
					'data: {"type":"text_start","contentIndex":0}\n',
					'data: {"type":"text_delta","contentIndex":0,"delta":"hi"}\n',
					'data: {"type":"text_end","contentIndex":0}\n',
					"data: [DONE]\n",
					`data: ${JSON.stringify({ type: "done", reason: "stop", usage: emptyUsage })}`,
				]),
			),
		);

		const stream = streamProxy(
			testModel,
			{ messages: [] },
			{ authToken: "token", proxyUrl: "https://proxy.example.test" },
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hi", textSignature: undefined }]);
	});

	it("emits an error result on malformed or non-object SSE payloads", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => sseResponse(['data: {"type":"start"}\n', "data: {bad-json\n"])),
		);

		const badJsonStream = streamProxy(
			testModel,
			{ messages: [] },
			{ authToken: "token", proxyUrl: "https://proxy.example.test" },
		);
		const badJsonResult = await badJsonStream.result();
		expect(badJsonResult.stopReason).toBe("error");
		expect(badJsonResult.errorMessage).toMatch(/Invalid proxy SSE JSON payload/);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => sseResponse(["data: []\n"])),
		);
		const nonObjectStream = streamProxy(
			testModel,
			{ messages: [] },
			{ authToken: "token", proxyUrl: "https://proxy.example.test" },
		);
		const nonObjectResult = await nonObjectStream.result();
		expect(nonObjectResult.stopReason).toBe("error");
		expect(nonObjectResult.errorMessage).toMatch(/expected JSON object with string type/);
	});

	// Regression test for https://github.com/earendil-works/pi/issues/8996
	it("emits an error instead of hanging when the stream ends without a terminal event", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sseResponse([
					'data: {"type":"start"}\n',
					'data: {"type":"text_start","contentIndex":0}\n',
					'data: {"type":"text_delta","contentIndex":0,"delta":"partial"}\n',
				]),
			),
		);

		const stream = streamProxy(
			testModel,
			{ messages: [] },
			{ authToken: "token", proxyUrl: "https://proxy.example.test" },
		);
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();

		expect(events).toEqual(["start", "text_start", "text_delta", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connection closed by proxy server");
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
	});
});
