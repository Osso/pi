import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

// OpenRouter commits 200 OK before a provider fails, then sends the failure as a chunk with a
// top-level `error` (https://openrouter.ai/docs/api/reference/streaming, "Errors after the
// response is committed"). The code is only in that body; the HTTP status stays 200.
const servers: http.Server[] = [];

async function serveChunk(chunk: unknown): Promise<string> {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify(chunk)}\n\n`);
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

function openRouterModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "stealth/crouton-alpha",
		name: "Crouton Alpha",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

describe("openai-completions mid-stream provider errors", () => {
	afterEach(() => {
		for (const server of servers.splice(0)) server.close();
	});

	it.each([
		{
			name: "numeric gateway code with an opaque message",
			error: { message: "ERROR", code: 502, metadata: { raw: "ERROR", provider_name: "Stealth" } },
			expected: '{"message":"ERROR","code":502,"metadata":{"raw":"ERROR","provider_name":"Stealth"}}',
		},
		{
			name: "documented server_error code",
			error: { code: "server_error", message: "Provider disconnected unexpectedly" },
			expected: '{"code":"server_error","message":"Provider disconnected unexpectedly"}',
		},
	])("keeps the error code from a $name so the turn is retryable", async ({ error, expected }) => {
		const baseUrl = await serveChunk({
			id: "gen-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "stealth/crouton-alpha",
			error,
			choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
		});

		const result = await streamOpenAICompletions(
			openRouterModel(baseUrl),
			{
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{ apiKey: "test-key", maxRetries: 0 },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(expected);
		expect(isRetryableAssistantError(result)).toBe(true);
	});
});
