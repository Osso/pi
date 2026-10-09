import { describe, expect, it } from "vitest";
import { isCodexCybersecurityRestriction as classifyBase } from "../src/base.ts";
import { isCodexCybersecurityRestriction as classifyCompat } from "../src/compat.ts";
import { isCodexCybersecurityRestriction as classifyPublic } from "../src/index.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { AssistantMessage } from "../src/types.ts";
import { isCodexCybersecurityRestriction, isRetryableAssistantError } from "../src/utils/retry.ts";

const canonicalError = "This content was flagged for possible cybersecurity risk.";

function codexError(errorMessage: string | undefined): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage, timestamp: 0 }),
		api: "openai-codex-responses",
		provider: "openai-codex",
	};
}

describe("Codex cybersecurity restriction classification", () => {
	it.each([
		canonicalError,
		`Codex error: ${canonicalError}`,
		`${canonicalError}\nOpenAI request ID: req_500`,
		`Codex error: ${canonicalError}\nOpenAI request ID: req_429`,
		`${canonicalError} You can retry your request.`,
		`Codex error: ${canonicalError} Please retry your request.\nOpenAI request ID: req_500_429`,
		`${canonicalError} If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber`,
	])("classifies the canonical restriction without mutating the message: %s", (errorMessage) => {
		const message = codexError(errorMessage);
		const before = structuredClone(message);
		expect(isCodexCybersecurityRestriction(message)).toBe(true);
		expect(message).toEqual(before);
	});

	it.each([
		undefined,
		"",
		"This content was flagged for possible cybersecurity risk",
		"This content was flagged for possible cybersecurity riskX",
		"This content was flagged for possible safety risk.",
		"this content was flagged for possible cybersecurity risk.",
		"Codex error: Access denied. You can retry your request.",
		`Unrelated error quoting: ${canonicalError}`,
	])("does not classify other errors: %s", (errorMessage) => {
		expect(isCodexCybersecurityRestriction(codexError(errorMessage))).toBe(false);
	});

	it.each(["openai-responses", "openai-completions", "anthropic-messages", "faux"])(
		"does not classify other APIs or change their retry classification: %s",
		(api) => {
			const message = { ...codexError(`${canonicalError} You can retry your request.`), api };
			expect(isCodexCybersecurityRestriction(message)).toBe(false);
			expect(isRetryableAssistantError(message)).toBe(true);
		},
	);

	it.each(["stop", "length", "toolUse", "aborted"] as const)(
		"does not classify non-error messages: %s",
		(stopReason) => {
			const message = { ...codexError(canonicalError), stopReason };
			expect(isCodexCybersecurityRestriction(message)).toBe(false);
			expect(isRetryableAssistantError(message)).toBe(false);
		},
	);

	it("does not classify canonical wording in successful content", () => {
		const message = { ...fauxAssistantMessage(canonicalError), api: "openai-codex-responses" };
		expect(isCodexCybersecurityRestriction(message)).toBe(false);
	});

	it.each(["500 internal server error", "429 rate limit", "You can retry your request."])(
		"preserves Codex transient errors: %s",
		(errorMessage) => {
			const message = codexError(errorMessage);
			expect(isCodexCybersecurityRestriction(message)).toBe(false);
			expect(isRetryableAssistantError(message)).toBe(true);
		},
	);

	it.each([
		["public", classifyPublic],
		["compat", classifyCompat],
		["base", classifyBase],
	] as const)("classifies through the %s entrypoint", (_name, classify) => {
		expect(classify(codexError(canonicalError))).toBe(true);
		expect(classify(codexError("500 internal server error"))).toBe(false);
	});
});
