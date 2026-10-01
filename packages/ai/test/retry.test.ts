import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';

describe("provider retry classification", () => {
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
