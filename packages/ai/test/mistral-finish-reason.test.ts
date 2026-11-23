import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

let server: Server | undefined;

afterEach(async () => {
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
});

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({
		id: "cmpl-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "mistral-large-latest",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;
}

async function streamChunks(chunks: string[]) {
	server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(`${chunks.join("")}data: [DONE]\n\n`);
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
	const model: Model<"mistral-conversations"> = { ...getModel("mistral", "mistral-large-latest"), baseUrl };
	return streamSimple(
		model,
		{ messages: [{ role: "user", content: "Say something", timestamp: Date.now() }] },
		{ apiKey: "fake-key" },
	);
}

describe("Mistral finish reasons", () => {
	it("reports finish_reason error as a retryable provider error", async () => {
		const result = await (await streamChunks([chunk({ content: "partial" }, "error")])).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stopped with: error (server error)");
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("reports an unknown finish_reason as a non-retryable provider error instead of success", async () => {
		const result = await (await streamChunks([chunk({ content: "partial" }, "unmapped_error")])).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stopped with: unmapped_error");
		expect(isRetryableAssistantError(result)).toBe(false);
	});
});
