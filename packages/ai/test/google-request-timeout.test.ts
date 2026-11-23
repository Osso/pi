import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import type { Context, Model } from "../src/types.ts";

const base = {
	id: "gemini-2.5-flash",
	name: "Gemini 2.5 Flash",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 65536,
} as const;
const googleModel: Model<"google-generative-ai"> = {
	...base,
	input: ["text"],
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://example.invalid/v1beta",
};
const vertexModel: Model<"google-vertex"> = {
	...base,
	input: ["text"],
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "https://example.invalid/v1",
};
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const chunk = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "late" }] }, finishReason: "STOP" }] })}\n\n`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mock fetch so headers arrive after `headerDelayMs` and the SSE body after a further `bodyDelayMs`. */
function mockGoogleFetch(headerDelayMs: number, bodyDelayMs: number): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		const signal = init?.signal ?? undefined;
		const aborted = new Promise<never>((_, reject) =>
			signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }),
		);
		await Promise.race([delay(headerDelayMs), aborted]);
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				await Promise.race([delay(bodyDelayMs), aborted]).catch((error) => controller.error(error));
				controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	});
}

const adapters = [
	{
		name: "google-generative-ai",
		run: (timeoutMs: number) => streamGoogle(googleModel, context, { apiKey: "k", timeoutMs }),
	},
	{
		name: "google-vertex",
		run: (timeoutMs: number) => streamGoogleVertex(vertexModel, context, { apiKey: "k", timeoutMs }),
	},
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Google request timeout", () => {
	it.each(adapters)("fails when response headers exceed timeoutMs on $name", async ({ run }) => {
		mockGoogleFetch(300, 0);

		const result = await run(40).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out after 40ms");
		expect(result.content).toEqual([]);
	});

	it.each(adapters)("does not cut off a stream body that outlasts timeoutMs on $name", async ({ run }) => {
		mockGoogleFetch(0, 120);

		const result = await run(40).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "late" }]);
	});
});
