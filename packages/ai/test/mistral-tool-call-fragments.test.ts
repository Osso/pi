import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

let server: Server | undefined;

afterEach(async () => {
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
});

/** Serve one streamed chat completion made of the given delta chunks. */
async function serveChunks(deltas: unknown[], finishReason: string): Promise<string> {
	server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta: unknown, finish: string | null) =>
			`data: ${JSON.stringify({
				id: "cmpl-1",
				object: "chat.completion.chunk",
				created: 1,
				model: "mistral-large-latest",
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`;
		for (const delta of deltas) response.write(chunk(delta, null));
		response.write(chunk({}, finishReason));
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

describe("Mistral streamed tool call fragments", () => {
	it("joins a continuation fragment that omits the tool call id", async () => {
		const baseUrl = await serveChunks(
			[
				{ tool_calls: [{ id: "abc123xyz", index: 0, function: { name: "read", arguments: '{"path":"' } }] },
				{ tool_calls: [{ index: 0, function: { name: "read", arguments: 'README.md"}' } }] },
			],
			"tool_calls",
		);
		const model: Model<"mistral-conversations"> = { ...getModel("mistral", "mistral-large-latest"), baseUrl };

		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Read the readme", timestamp: Date.now() }] },
			{ apiKey: "fake-key" },
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "abc123xyz", name: "read", arguments: { path: "README.md" } },
		]);
	});
});
