import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { Context, ToolResultMessage } from "../src/types.ts";

describe("OpenAI Responses orphan tool results", () => {
	it("drops tool results that have no visible preceding tool call", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		const orphanToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_orphan|fc_orphan",
			toolName: "grep",
			content: [{ type: "text", text: "orphaned output" }],
			isError: false,
			timestamp: Date.now() - 1000,
		};
		const context: Context = {
			systemPrompt: "You are concise.",
			messages: [orphanToolResult, { role: "user", content: "continue", timestamp: Date.now() }],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]));

		expect(input.some((item) => item.type === "function_call_output")).toBe(false);
		expect(input).toContainEqual({ role: "user", content: [{ type: "input_text", text: "continue" }] });
	});
});
