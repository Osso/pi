import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Model, ProviderHeaders } from "../src/types.ts";

let server: Server | undefined;

afterEach(async () => {
	server?.closeAllConnections();
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
});

const reply = `data: ${JSON.stringify({
	id: "cmpl-1",
	object: "chat.completion.chunk",
	created: 1,
	model: "mistral-large-latest",
	choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
})}\n\ndata: [DONE]\n\n`;

async function requestHeaders(
	modelHeaders: Record<string, string> | undefined,
	headers: ProviderHeaders,
): Promise<IncomingHttpHeaders> {
	let received: IncomingHttpHeaders = {};
	server = createServer((request, response) => {
		received = request.headers;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(reply);
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const model: Model<"mistral-conversations"> = {
		...getModel("mistral", "mistral-large-latest"),
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		headers: modelHeaders,
	};
	const result = await streamSimple(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "fake-key", sessionId: "session-123", headers },
	).result();
	expect(result.stopReason).toBe("stop");
	return received;
}

describe("Mistral request headers", () => {
	it("lets a caller X-Affinity header of any case replace the session default", async () => {
		const received = await requestHeaders(undefined, { "X-Affinity": "manual-456" });

		expect(received["x-affinity"]).toBe("manual-456");
	});

	it("drops a model default header when the caller overrides it with null", async () => {
		const received = await requestHeaders({ "x-label": "model-default" }, { "x-label": null });

		expect(received["x-label"]).toBeUndefined();
		expect(received["x-affinity"]).toBe("session-123");
	});
});
