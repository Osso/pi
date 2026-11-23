import { expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context } from "../src/types.ts";

// Upstream #12367: OpenAI returns tool calls with status "completed". Replaying them without it changes the
// input before later reasoning items, which GPT-6.2 drops as prefix_mismatch after a full Codex resend.
it("replays function tool calls with the status the API returned", () => {
	const model = getModel("openai", "gpt-5.5");
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "calc.py" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now() - 1000,
	};
	const context: Context = {
		messages: [
			{ role: "user", content: "Read calc.py", timestamp: Date.now() - 2000 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "call_1|fc_1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	};

	const input = convertResponsesMessages(model, context, new Set(["openai"]));

	expect(input).toContainEqual({
		type: "function_call",
		id: "fc_1",
		call_id: "call_1",
		name: "read",
		arguments: '{"path":"calc.py"}',
		status: "completed",
	});
});
