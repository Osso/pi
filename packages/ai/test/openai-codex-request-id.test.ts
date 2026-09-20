import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenAICodexWebSocketSessions, stream } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};
const message =
	"This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber";
const apiKey = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.bbb`;

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
});

async function assertError(transport: "sse" | "websocket", expected: string) {
	const events = stream(
		model,
		{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
		{
			apiKey,
			transport,
			sessionId: "not-a-server-request-id",
			maxRetries: 0,
		},
	);
	const emitted: string[] = [];
	for await (const event of events) {
		if (event.type === "error") emitted.push(event.error.errorMessage ?? "");
	}
	expect(emitted).toEqual([expected]);
	expect((await events.result()).errorMessage).toBe(expected);
}

function mockWebSocket(payload: Record<string, unknown>) {
	class Socket extends EventTarget {
		constructor() {
			super();
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		send() {
			setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })), 0);
		}
		close() {}
	}
	vi.stubGlobal("WebSocket", Socket);
}

describe("Codex support request IDs", () => {
	it.each([undefined, "req_http"])("preserves HTTP errors with header %s", async (id) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: { message } }), {
						status: 403,
						headers: id ? { "x-request-id": id } : {},
					}),
			),
		);
		await assertError("sse", id ? `${message}\nOpenAI request ID: ${id}` : message);
	});

	it.each([undefined, "req_http"])("preserves HTTP body ID with header %s", async (id) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ request_id: "req_body", error: { message, request_id: "req_nested" } }), {
						status: 403,
						headers: id ? { "x-request-id": id } : {},
					}),
			),
		);
		await assertError("sse", `${message}\nOpenAI request ID: ${id ?? "req_body"}`);
	});

	it.each(["error", "response.failed"])("preserves SSE %s HTTP request ID", async (type) => {
		const error = { message, request_id: "req_nested" };
		const payload = {
			type,
			request_id: "req_event",
			...(type === "error" ? { error } : {}),
			response: { ...(type === "response.failed" ? { error } : {}), request_id: "req_response" },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(`data: ${JSON.stringify(payload)}\n\n`, {
						headers: { "x-request-id": "req_http" },
					}),
			),
		);
		await assertError("sse", `${type === "error" ? "Codex error: " : ""}${message}\nOpenAI request ID: req_http`);
	});

	it.each([
		{
			name: "error with top ID",
			payload: { type: "error", request_id: "req_top", error: { message }, response: { id: "resp_not_request" } },
			expected: `Codex error: ${message}\nOpenAI request ID: req_top`,
		},
		{
			name: "error with nested ID",
			payload: { type: "error", error: { message, request_id: "req_nested" }, response: { id: "resp_not_request" } },
			expected: `Codex error: ${message}\nOpenAI request ID: req_nested`,
		},
		{
			name: "error with response ID",
			payload: {
				type: "error",
				error: { message },
				response: { id: "resp_not_request", request_id: "req_response" },
			},
			expected: `Codex error: ${message}\nOpenAI request ID: req_response`,
		},
		{
			name: "error with absent ID",
			payload: { type: "error", error: { message }, response: { id: "resp_not_request" } },
			expected: `Codex error: ${message}`,
		},
		{
			name: "error with invalid ID",
			payload: { type: "error", request_id: 123, error: { message }, response: { id: "resp_not_request" } },
			expected: `Codex error: ${message}`,
		},
		{
			name: "response.failed with top ID",
			payload: {
				type: "response.failed",
				request_id: "req_top",
				response: { id: "resp_not_request", error: { message } },
			},
			expected: `${message}\nOpenAI request ID: req_top`,
		},
		{
			name: "response.failed with nested ID",
			payload: {
				type: "response.failed",
				response: { id: "resp_not_request", error: { message, request_id: "req_nested" } },
			},
			expected: `${message}\nOpenAI request ID: req_nested`,
		},
		{
			name: "response.failed with response ID",
			payload: {
				type: "response.failed",
				response: { id: "resp_not_request", request_id: "req_response", error: { message } },
			},
			expected: `${message}\nOpenAI request ID: req_response`,
		},
		{
			name: "response.failed with absent ID",
			payload: { type: "response.failed", response: { id: "resp_not_request", error: { message } } },
			expected: message,
		},
		{
			name: "response.failed with invalid ID",
			payload: {
				type: "response.failed",
				request_id: 123,
				response: { id: "resp_not_request", error: { message } },
			},
			expected: message,
		},
	])("preserves WebSocket $name", async ({ payload, expected }) => {
		mockWebSocket(payload);
		await assertError("websocket", expected);
	});
});
