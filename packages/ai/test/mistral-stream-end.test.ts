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

describe("Mistral stream end", () => {
	it("reports an error that keeps partial text when the body ends without a finish_reason", async () => {
		server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify({
					id: "cmpl-1",
					object: "chat.completion.chunk",
					created: 1,
					model: "mistral-large-latest",
					choices: [{ index: 0, delta: { content: "Partial" }, finish_reason: null }],
				})}\n\n`,
			);
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
		const model: Model<"mistral-conversations"> = { ...getModel("mistral", "mistral-large-latest"), baseUrl };

		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "Say something", timestamp: Date.now() }] },
			{ apiKey: "fake-key" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("finish_reason");
		expect(result.content).toEqual([{ type: "text", text: "Partial" }]);
	});
});
