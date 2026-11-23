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

describe("Mistral empty content deltas", () => {
	it("does not open text blocks for empty deltas around thinking", async () => {
		const response = await streamChunks([
			chunk({ role: "assistant", content: "" }),
			chunk({ content: [{ type: "thinking", thinking: [{ type: "text", text: "Plan" }] }] }),
			chunk({ content: "" }),
			chunk({ content: [{ type: "thinking", thinking: [{ type: "text", text: " more" }] }] }),
			chunk({ content: [{ type: "text", text: "" }] }),
			chunk({ content: "Answer" }, "stop"),
		]);
		const eventTypes: string[] = [];
		for await (const event of response) eventTypes.push(event.type);
		const result = await response.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "Plan more" },
			{ type: "text", text: "Answer" },
		]);
		expect(eventTypes.filter((type) => type === "text_start")).toHaveLength(1);
	});
});
