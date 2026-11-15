import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import {
	classifyProviderError,
	classifyProviderErrorText,
	isQuotaExhaustionError,
	isRateLimitError,
	isRetryableAssistantError,
	isRetryableHttpError,
} from "../src/utils/retry.ts";

const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';

describe("provider retry classification", () => {
	it.each([
		"This content was flagged for possible cybersecurity risk.\nOpenAI request ID: req_500",
		"Codex error: This content was flagged for possible cybersecurity risk.\nOpenAI request ID: req_429",
		"Codex error: This content was flagged for possible cybersecurity risk. You can retry your request.",
	])("does not retry canonical Codex cybersecurity restrictions: %s", (errorMessage) => {
		const message = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			api: "openai-codex-responses",
		};
		expect(isRetryableAssistantError(message)).toBe(false);
	});

	it("does not retry the legacy max-output error but retries generic incomplete responses", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Incomplete response returned, reason: max_output_tokens",
				}),
			),
		).toBe(false);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Incomplete response returned, reason: unknown",
				}),
			),
		).toBe(true);
	});

	it("does not retry content-filter incomplete responses", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Incomplete response returned, reason: content_filter",
				}),
			),
		).toBe(false);
	});

	it("retries OpenAI per-minute token limits that link to the billing page", () => {
		const errorMessage =
			'OpenAI API error (429): {"type":"tokens","code":"rate_limit_exceeded","message":"Rate limit reached for gpt-6.1-sol in organization org-test on tokens per min (TPM): Limit 1000000, Used 891273, Requested 360562. Please try again in 15.11s. Visit https://platform.openai.com/account/rate-limits to learn more. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.","param":null}';
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429: billing hard limit reached" }),
			),
		).toBe(false);
	});

	it("does not retry OpenRouter credit exhaustion whose key URL contains retryable status digits", () => {
		const errorMessage =
			'402 This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 18096. To increase, visit https://openrouter.ai/workspaces/default/keys/35249299e1719a8b and adjust the key\'s weekly limit: {"code":402,"metadata":{"error_type":"payment_required"}}';
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it("matches OpenAI Responses streams ending before a terminal event", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "OpenAI Responses stream ended before a terminal response event",
				}),
			),
		).toBe(true);
	});

	it("matches OpenAI server processing errors", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "The server had an error while processing your request. Sorry about that!",
				}),
			),
		).toBe(true);
	});

	it("matches gateway wording for upstream provider errors", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "The upstream provider returned an error" }),
			),
		).toBe(true);
	});

	it("matches explicit provider retry guidance", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
			),
		).toBe(true);
	});

	it.each([
		"Codex error: Unable to verify Daybreak Blue access. Please try again.",
		"Codex error: Unable to verify Daybreak Blue access. Please try again.\nOpenAI request ID: req_daybreak_123",
	])("retries the exact Daybreak Blue verification error: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		"Codex error: Daybreak Blue access denied. Please try again.",
		"Codex error: Daybreak Blue access denied. Please try again.\nOpenAI request ID: req_denied_123",
		"Codex error: You do not have access to Daybreak Blue.",
		"Codex error: Please try again.",
		"Codex error: Unable to verify another model access. Please try again.",
		"Codex error: Unable to verify Daybreak Blue access. Please try again. Access permanently denied.",
		"Codex error: Unable to verify Daybreak Blue accessX Please try againX",
	])("does not broaden Daybreak Blue retries to other errors: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it.each([
		"WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: Expected 101 status code",
		"Error: WebSocket connection to 'wss://proxy.example.test/codex/responses?session=abc' failed: Expected 101 status code",
		"error: websocket connection to 'wss://example.test/responses' failed: expected 101 status\t code",
	])("retries runtime Expected-101 handshake failures: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it.each([
		"WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: 401 Unauthorized",
		"Error: WebSocket connection to 'wss://chatgpt.com/backend-api/codex/responses' failed: 403 Forbidden",
		"WebSocket connection to 'wss://example.test/responses' failed: 400 Bad Request",
		"WebSocket connection to 'wss://example.test/responses' failed: invalid_api_key",
		"WebSocket connection to 'wss://example.test/responses' failed: Expected 101 status code; received 403 Forbidden",
		"Expected 101 status code",
	])("does not broaden handshake retries to permanent or unrelated failures: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it("does not retry upstream request buffer limit overflow errors", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				}),
			),
		).toBe(false);
	});

	it("keeps provider limit errors non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
			),
		).toBe(false);
	});

	it("classifies assistant error messages", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "524 status code (no body)" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage:
						"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
				}),
			),
		).toBe(true);
		expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
	});
});

describe("provider error classification matrix", () => {
	it.each([
		{
			label: "OpenCode GoUsageLimitError (429)",
			text: 'GoUsageLimitError: {"type":"GoUsageLimitError"}',
			expectedKind: "quota_exhausted",
			retryable: false,
			rateLimited: false,
			quotaExhausted: true,
		},
		{
			label: "OpenCode FreeUsageLimitError (429)",
			text: 'FreeUsageLimitError: {"type":"FreeUsageLimitError"}',
			expectedKind: "quota_exhausted",
			retryable: false,
			rateLimited: false,
			quotaExhausted: true,
		},
		{
			label: "OpenAI 429 credit_balance_exhausted",
			text: 'OpenAI API error (429): 429 {"error":{"message":"Your credit balance is exhausted","type":"billing_error","code":"credit_balance_exhausted"}}',
			expectedKind: "quota_exhausted",
			retryable: false,
			rateLimited: false,
			quotaExhausted: true,
		},
		{
			label: "OpenAI insufficient_quota",
			text: "insufficient_quota",
			expectedKind: "quota_exhausted",
			retryable: false,
			rateLimited: false,
			quotaExhausted: true,
		},
		{
			label: "DeepSeek Insufficient Balance",
			text: '{"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
			expectedKind: "quota_exhausted",
			retryable: false,
			rateLimited: false,
			quotaExhausted: true,
		},
		{
			label: "OpenRouter 402 Insufficient credits",
			text: 'OpenAI API error (402): {"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402,"metadata":{"limit_source":"openrouter_credits"}}',
			expectedKind: "quota_exhausted",
			retryable: false,
			rateLimited: false,
			quotaExhausted: true,
		},
		{
			label: "OpenRouter 402 requires more credits",
			text: '402 This request requires more credits, or fewer max_tokens. {"code":402}',
			expectedKind: "quota_exhausted",
			retryable: false,
			rateLimited: false,
			quotaExhausted: true,
		},
		{
			label: "Codex ChatGPT usage limit",
			text: "You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min.",
			expectedKind: "quota_exhausted",
			retryable: false,
			rateLimited: false,
			quotaExhausted: true,
		},
		{
			label: "OpenAI TPM 429 with /account/billing URL",
			text: 'OpenAI API error (429): {"type":"tokens","code":"rate_limit_exceeded","message":"Rate limit reached on tokens per min (TPM). Visit https://platform.openai.com/account/billing."}',
			expectedKind: "rate_limited",
			retryable: true,
			rateLimited: true,
			quotaExhausted: false,
		},
		{
			label: "OpenAI Request too large on tokens per min without 429",
			text: "OpenAI API error: Request too large for gpt-6.1-sol in organization org-test on tokens per min (TPM): Limit 2000000, Requested 2400000.",
			expectedKind: "throughput_limited",
			retryable: false,
			rateLimited: true,
			quotaExhausted: false,
		},
		{
			label: "Claude bridge rate limit rejection",
			text: "Claude rate limit (five_hour): You're out of extra usage",
			expectedKind: "rate_limited",
			retryable: true,
			rateLimited: true,
			quotaExhausted: false,
		},
		{
			label: "HTTP 503 transient failure",
			text: "503 Service Unavailable",
			expectedKind: "transient",
			retryable: true,
			rateLimited: false,
			quotaExhausted: false,
		},
		{
			label: "Authentication failure (401)",
			text: "401 Unauthorized: invalid_api_key",
			expectedKind: "unknown",
			retryable: false,
			rateLimited: false,
			quotaExhausted: false,
		},
	])("classifies $label", ({ text, expectedKind, retryable, rateLimited, quotaExhausted }) => {
		const byText = classifyProviderErrorText(text);
		expect(byText).toEqual({ kind: expectedKind, retryable, rateLimited, quotaExhausted });

		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: text });
		expect(classifyProviderError(message)).toEqual(byText);
		expect(isQuotaExhaustionError(message)).toBe(quotaExhausted);
		expect(isRateLimitError(message)).toBe(rateLimited);
		expect(isRetryableAssistantError(message)).toBe(retryable);
	});

	it("classifies HTTP status codes alongside response bodies", () => {
		expect(isRetryableHttpError(503, "upstream temporarily unavailable")).toBe(true);
		expect(isRetryableHttpError(429, "Please slow down")).toBe(true);
		expect(isRetryableHttpError(429, "https://platform.openai.com/account/billing")).toBe(true);
		expect(isRetryableHttpError(429, '{"error":{"code":"insufficient_quota"}}')).toBe(false);
		expect(isRetryableHttpError(429, "You have hit your ChatGPT usage limit")).toBe(false);
		expect(isRetryableHttpError(402, "requires more credits")).toBe(false);
		expect(isRetryableHttpError(401, "Unauthorized")).toBe(false);
	});
});
