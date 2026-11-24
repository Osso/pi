import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

let server: Server | undefined;

afterEach(async () => {
	server?.closeAllConnections();
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
});

function chunk(content: string, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({
		id: "cmpl-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "mistral-large-latest",
		choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
	})}\n\n`;
}

async function startServer(handler: Parameters<typeof createServer>[1]): Promise<Model<"mistral-conversations">> {
	server = createServer(handler);
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
	return { ...getModel("mistral", "mistral-large-latest"), baseUrl };
}

function ask(model: Model<"mistral-conversations">, timeoutMs: number) {
	return streamSimple(
		model,
		{ messages: [{ role: "user", content: "Say something", timestamp: Date.now() }] },
		{ apiKey: "fake-key", timeoutMs },
	).result();
}

describe("Mistral request timeout", () => {
	it("fails when response headers do not arrive within timeoutMs", async () => {
		const model = await startServer((_request, response) => {
			setTimeout(() => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(`${chunk("late", "stop")}data: [DONE]\n\n`);
			}, 400);
		});

		const result = await ask(model, 50);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Mistral response headers timed out after 50ms");
		expect(result.content).toEqual([]);
	});

	it("keeps streaming a body that lasts longer than timeoutMs after headers arrive", async () => {
		const model = await startServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(chunk("early "));
			setTimeout(() => response.end(`${chunk("late", "stop")}data: [DONE]\n\n`), 1_500);
		});

		// Headers are written at once; a 1 s deadline only absorbs scheduling delay on a loaded host.
		const result = await ask(model, 1_000);

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "early late" }]);
	});
});
