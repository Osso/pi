import { expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context } from "../src/types.ts";

it("does not replay reasoning that has no following output item after an output-token cutoff", () => {
	const model = getModel("openai", "gpt-5.5");
	const reasoning = { type: "reasoning", id: "rs_plan", summary: [], encrypted_content: "cipher" };
	// An output-token cutoff during a tool call keeps the signed reasoning and drops the partial call.
	const cutOff: AssistantMessage = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "Plan", thinkingSignature: JSON.stringify(reasoning) }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 16,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 26,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "length",
		timestamp: Date.now() - 1000,
	};
	const context: Context = {
		messages: [
			{ role: "user", content: "Hi", timestamp: Date.now() - 2000 },
			cutOff,
			{ role: "user", content: "Continue", timestamp: Date.now() },
		],
	};

	const input = convertResponsesMessages(model, context, new Set(["openai"]));

	expect(input).toEqual([
		{ role: "user", content: [{ type: "input_text", text: "Hi" }] },
		{ role: "user", content: [{ type: "input_text", text: "Continue" }] },
	]);
});
