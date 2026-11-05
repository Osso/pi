import { describe, expect, it } from "vitest";
import { compactionRetryCooldownMs } from "../src/core/compaction-retry.ts";

describe("compactionRetryCooldownMs", () => {
	it("honors an explicit provider retry hint", () => {
		expect(
			compactionRetryCooldownMs(
				"Summarization failed: 429 rate limit reached for gpt-6-luna. Please try again in 767.207s.",
			),
		).toBe(767_207);
	});

	it("uses a default cooldown for a rate limit without a hint", () => {
		expect(compactionRetryCooldownMs("Summarization failed: 429 Too Many Requests")).toBe(60_000);
	});

	it("ignores non-rate-limit failures", () => {
		expect(compactionRetryCooldownMs("Summarization failed: 500 upstream error")).toBeUndefined();
	});

	it("caps very long hints at one hour", () => {
		expect(compactionRetryCooldownMs("rate limit exceeded; try again in 999m")).toBe(3_600_000);
	});
});
