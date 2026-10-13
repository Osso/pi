import { describe, expect, it } from "vitest";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "capture-model",
	name: "Capture Model",
	api: "openai-completions",
	provider: "capture-provider",
	baseUrl: "https://capture.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

describe("simple stream base options", () => {
	it("preserves caller cwd and shared options when adapting a simple request", () => {
		const options: SimpleStreamOptions = {
			cwd: "/tmp/embedded-session-project",
			temperature: 0.25,
			maxTokens: 123,
			signal: new AbortController().signal,
			apiKey: "test-api-key",
			transport: "sse",
			cacheRetention: "long",
			sessionId: "capture-session",
			headers: { "x-capture": "preserved" },
			env: { CAPTURE_ENV: "preserved" },
			metadata: { caller: "embedded" },
			timeoutMs: 456,
			websocketConnectTimeoutMs: 789,
			maxRetries: 2,
			maxRetryDelayMs: 321,
			onPayload: (payload) => payload,
			onResponse: () => {},
			onRetry: () => {},
		};

		expect(buildBaseOptions(model, { messages: [] }, options)).toMatchObject(options);
	});
});
