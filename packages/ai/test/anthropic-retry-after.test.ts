import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

function rateLimitedClient(headers: Record<string, string>): Anthropic {
	return new Anthropic({
		apiKey: "test-key",
		maxRetries: 0,
		fetch: async () =>
			new Response(
				JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limit reached" } }),
				{ status: 429, headers: { "content-type": "application/json", ...headers } },
			),
	});
}

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: 1 }],
};

describe("Anthropic rate limit retry delay", () => {
	it("records the Retry-After delay from a 429 response", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		const result = await streamAnthropic(model, context, {
			client: rateLimitedClient({ "retry-after": "900" }),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Rate limit reached");
		expect(result.retryAfterMs).toBe(900_000);
	});

	it("leaves the delay unset when the response states none", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		const result = await streamAnthropic(model, context, { client: rateLimitedClient({}) }).result();

		expect(result.stopReason).toBe("error");
		expect(result.retryAfterMs).toBeUndefined();
	});
});
