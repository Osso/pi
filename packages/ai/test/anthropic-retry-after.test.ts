import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

function rateLimitedClient(headers: Record<string, string>, message = "Rate limit reached"): Anthropic {
	return new Anthropic({
		apiKey: "test-key",
		maxRetries: 0,
		fetch: async () =>
			new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message } }), {
				status: 429,
				headers: { "content-type": "application/json", ...headers },
			}),
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

	it("records the proxy cooldown reset rather than an individual credential's cooldown", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const message =
			"All credentials for model claude-opus-5-5 are cooling down via provider claude " +
			"(last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.) " +
			"(reset after 3h17m42s) [credential errors: " +
			"account-a: rate_limit_error: Please try again later. (cooling down, 20h37m37s left); " +
			"account-b: rate_limit_error: Please try again later. (cooling down, 3h17m42s left)]";

		const result = await streamAnthropic(model, context, { client: rateLimitedClient({}, message) }).result();

		expect(result.stopReason).toBe("error");
		expect(result.retryAfterMs).toBe(11_862_000);
	});

	it("leaves the delay unset when the response states none", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		const result = await streamAnthropic(model, context, { client: rateLimitedClient({}) }).result();

		expect(result.stopReason).toBe("error");
		expect(result.retryAfterMs).toBeUndefined();
	});
});
