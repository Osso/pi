import { describe, expect, it, vi } from "vitest";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { getErrorRetryAfterMs, getRetryAfterMs, getRetryAfterMsFromText } from "../src/utils/retry-after.ts";

const openAIError = {
	status: 429,
	message:
		"Rate limit reached for gpt-6-luna in organization org-test on tokens per min (TPM): Limit 100000, Used 93468, Requested 26637.",
	error: { type: "tokens", code: "rate_limit_exceeded" },
	headers: new Headers({ "retry-after": "520526" }),
};

vi.mock("openai", () => {
	class FakeOpenAI {
		responses = {
			create: () => {
				const promise = Promise.resolve(undefined) as Promise<unknown> & {
					withResponse: () => Promise<unknown>;
				};
				promise.withResponse = async () => {
					throw openAIError;
				};
				return promise;
			},
		};
	}

	return { default: FakeOpenAI, AzureOpenAI: FakeOpenAI };
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function createContext(): Context {
	return {
		systemPrompt: "Test",
		messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
	};
}

describe("retry-after parsing", () => {
	it("prefers retry-after-ms over retry-after", () => {
		const headers = new Headers({ "retry-after-ms": "1500", "retry-after": "9" });
		expect(getRetryAfterMs(headers)).toBe(1500);
	});

	it("parses retry-after seconds", () => {
		expect(getRetryAfterMs(new Headers({ "retry-after": "520526" }))).toBe(520_526_000);
	});

	it("parses an HTTP date retry-after", () => {
		const headers = new Headers({ "retry-after": new Date(Date.now() + 60_000).toUTCString() });
		const delayMs = getRetryAfterMs(headers);
		expect(delayMs).toBeGreaterThan(58_000);
		expect(delayMs).toBeLessThanOrEqual(60_000);
	});

	it("returns undefined for absent or invalid headers", () => {
		expect(getRetryAfterMs(undefined)).toBeUndefined();
		expect(getRetryAfterMs(new Headers())).toBeUndefined();
		expect(getRetryAfterMs(new Headers({ "retry-after": "not-a-delay" }))).toBeUndefined();
	});

	it("ignores blank retry-after values instead of treating them as zero", () => {
		expect(getRetryAfterMs(new Headers({ "retry-after-ms": "", "retry-after": "120" }))).toBe(120_000);
		expect(getRetryAfterMs(new Headers({ "retry-after": " " }))).toBeUndefined();
		const error = Object.assign(new Error("Rate limit reached. Please try again in 2m4s."), {
			headers: new Headers({ "retry-after": "" }),
		});
		expect(getErrorRetryAfterMs(error)).toBe(124_000);
	});

	it("reads retry-after from an SDK error", () => {
		expect(getErrorRetryAfterMs(openAIError)).toBe(520_526_000);
		expect(getErrorRetryAfterMs(new Error("plain error"))).toBeUndefined();
	});

	it("parses a provider-stated delay from error text", () => {
		expect(getRetryAfterMsFromText("Rate limit reached. Please try again in 142h36m11.52s.")).toBe(
			142 * 3_600_000 + 36 * 60_000 + 11_520,
		);
		expect(getRetryAfterMsFromText("Rate limit reached. Please try again in 15.11s.")).toBe(15_110);
		expect(getRetryAfterMsFromText("Please retry in 41.297487613s.")).toBe(41_297);
		expect(
			getRetryAfterMsFromText(
				'{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"120.500s"}]}}',
			),
		).toBe(120_500);
		expect(getRetryAfterMsFromText("no delay here")).toBeUndefined();
		expect(getRetryAfterMsFromText(undefined)).toBeUndefined();
	});

	it("parses the aggregate provider cooldown duration", () => {
		expect(getRetryAfterMsFromText("All credentials are cooling down (reset after 5h)")).toBe(18_000_000);
		expect(getRetryAfterMsFromText("All credentials are cooling down (reset after 17m)")).toBe(1_020_000);
		expect(getRetryAfterMsFromText("All credentials are cooling down (reset after 42s)")).toBe(42_000);
		expect(
			getRetryAfterMsFromText("All credentials are cooling down (reset after an unknown delay)"),
		).toBeUndefined();
	});

	it("falls back to error text when the response carried no retry-after header", () => {
		const error = new Error("Error Code tokens: Rate limit reached. Please try again in 2m4s.");
		expect(getErrorRetryAfterMs(error)).toBe(124_000);
	});
});

describe("openai-responses retry metadata", () => {
	it("keeps the provider-requested retry delay on the failed assistant message", async () => {
		const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);

		const errorEvent = events.find((event) => event.type === "error");
		expect(errorEvent).toBeDefined();
		const message = (errorEvent as { error: AssistantMessage }).error;
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Rate limit reached");
		expect(message.retryAfterMs).toBe(520_526_000);
	});
});

describe("azure-openai-responses retry metadata", () => {
	it("keeps the provider-requested retry delay on the failed assistant message", async () => {
		const model: Model<"azure-openai-responses"> = {
			...createModel(),
			compat: undefined,
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			baseUrl: "https://example.openai.azure.com/openai/v1",
		};
		const message = await streamAzureOpenAIResponses(model, createContext(), { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Rate limit reached");
		expect(message.retryAfterMs).toBe(520_526_000);
	});
});
