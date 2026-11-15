import type { AssistantMessage } from "../types.ts";

const CODEX_CYBERSECURITY_RESTRICTION = "This content was flagged for possible cybersecurity risk.";
const RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);

export type ProviderErrorKind =
	| "none"
	| "quota_exhausted"
	| "non_retryable"
	| "rate_limited"
	| "throughput_limited"
	| "transient"
	| "unknown";

export interface ProviderErrorClassification {
	kind: ProviderErrorKind;
	retryable: boolean;
	rateLimited: boolean;
	quotaExhausted: boolean;
}

const CLASSIFICATION_FLAGS: Record<ProviderErrorKind, ProviderErrorClassification> = {
	none: { kind: "none", retryable: false, rateLimited: false, quotaExhausted: false },
	quota_exhausted: { kind: "quota_exhausted", retryable: false, rateLimited: false, quotaExhausted: true },
	non_retryable: { kind: "non_retryable", retryable: false, rateLimited: false, quotaExhausted: false },
	rate_limited: { kind: "rate_limited", retryable: true, rateLimited: true, quotaExhausted: false },
	throughput_limited: { kind: "throughput_limited", retryable: false, rateLimited: true, quotaExhausted: false },
	transient: { kind: "transient", retryable: true, rateLimited: false, quotaExhausted: false },
	unknown: { kind: "unknown", retryable: false, rateLimited: false, quotaExhausted: false },
};

/** Identifies the canonical Codex cybersecurity restriction, including provider suffixes and request IDs. */
export function isCodexCybersecurityRestriction(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || message.api !== "openai-codex-responses" || !message.errorMessage) {
		return false;
	}
	return (
		message.errorMessage.startsWith(CODEX_CYBERSECURITY_RESTRICTION) ||
		message.errorMessage.startsWith(`Codex error: ${CODEX_CYBERSECURITY_RESTRICTION}`)
	);
}

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const QUOTA_EXHAUSTION_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// Subscription/plan usage limits (OpenCode Go monthly limit, ChatGPT Codex usage limit).
	"usage limit",
	"available balance",

	// Account credit/balance exhaustion (DeepSeek, OpenRouter, OpenAI).
	"Insufficient (?:Balance|credits)",
	"requires more credits",
	"insufficient_quota",
	"credit_balance_exhausted",
	"out of budget",
	"quota exceeded",

	// Generic billing limit/error wording. Excludes URL paths so OpenAI's transient
	// TPM/RPM 429 link (`platform.openai.com/account/billing`) is not treated as quota.
	"(?<!/)billing",
]);

const NON_RETRYABLE_REASON_PATTERN = buildProviderErrorPattern([
	// These terminal reasons are deterministic for an unchanged request.
	"Incomplete response returned, reason: max_output_tokens",
	"Incomplete response returned, reason: content_filter",
]);

const RATE_LIMIT_PATTERN = buildProviderErrorPattern(["rate.?limit", "too many requests", "\\b429\\b"]);

/** Per-minute account throughput exhaustion (e.g. "Request too large ... on tokens per min"). */
const THROUGHPUT_LIMIT_PATTERN = buildProviderErrorPattern(["(?:tokens|requests) per min"]);

const TRANSIENT_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"\\b500\\b",
	"\\b502\\b",
	"\\b503\\b",
	"\\b504\\b",
	"\\b524\\b",
	"service.?unavailable",
	"server.?error",
	"server had an error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264) and gateway wording such as
	// "The upstream provider returned an error" (#10842).
	"provider.?returned.?(?:an.?)?error",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"closed unexpectedly",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",
	"^(?:Error:\\s*)?WebSocket connection to 'wss://[^'\\s]+' failed: Expected 101 status\\s+code$",

	// Premature or incomplete stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); OpenAI can emit response.incomplete; Bedrock/Smithy can throw an HTTP/2
	// no-response error (#3594).
	"Incomplete response returned",
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Codex access-verification failure, optionally followed by its request ID.
	"^Codex error: Unable to verify Daybreak Blue access\\. Please try again\\.(?:\\nOpenAI request ID: [^\\r\\n]+)?$",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",
]);

/**
 * Classifies a provider error string (and optional HTTP status) into one canonical category.
 * Precedence: quota exhaustion -> deterministic non-retryable -> rate limit -> throughput limit -> transient.
 */
export function classifyProviderErrorText(errorText: string, status?: number): ProviderErrorClassification {
	if (!errorText && status === undefined) return CLASSIFICATION_FLAGS.none;
	if (QUOTA_EXHAUSTION_PATTERN.test(errorText)) return CLASSIFICATION_FLAGS.quota_exhausted;
	if (NON_RETRYABLE_REASON_PATTERN.test(errorText)) return CLASSIFICATION_FLAGS.non_retryable;
	if (status === 429 || RATE_LIMIT_PATTERN.test(errorText)) return CLASSIFICATION_FLAGS.rate_limited;
	if (THROUGHPUT_LIMIT_PATTERN.test(errorText)) return CLASSIFICATION_FLAGS.throughput_limited;
	if (
		(status !== undefined && RETRYABLE_HTTP_STATUSES.has(status)) ||
		TRANSIENT_PROVIDER_ERROR_PATTERN.test(errorText)
	) {
		return CLASSIFICATION_FLAGS.transient;
	}
	return CLASSIFICATION_FLAGS.unknown;
}

/** Classifies a failed AssistantMessage into one canonical provider error category. */
export function classifyProviderError(message: AssistantMessage): ProviderErrorClassification {
	if (message.stopReason !== "error" || !message.errorMessage) return CLASSIFICATION_FLAGS.none;
	if (isCodexCybersecurityRestriction(message)) return CLASSIFICATION_FLAGS.non_retryable;
	return classifyProviderErrorText(message.errorMessage);
}

export function isQuotaExhaustionErrorText(errorText: string): boolean {
	return classifyProviderErrorText(errorText).quotaExhausted;
}

export function isQuotaExhaustionError(message: AssistantMessage): boolean {
	return classifyProviderError(message).quotaExhausted;
}

export function isRateLimitErrorText(errorText: string): boolean {
	return classifyProviderErrorText(errorText).rateLimited;
}

export function isRateLimitError(message: AssistantMessage): boolean {
	return classifyProviderError(message).rateLimited;
}

export function isRetryableHttpError(status: number, errorText: string): boolean {
	return classifyProviderErrorText(errorText, status).retryable;
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	return classifyProviderError(message).retryable;
}
