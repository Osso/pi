import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";

const compat: Required<OpenAICompletionsCompat> = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
};

function emptyToolResultContext(
	model: Model<"openai-completions" | "openai-responses" | "openai-codex-responses">,
): Context {
	const toolCall: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1|fc_1", name: "touch", arguments: {} }],
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
		timestamp: 1,
	};
	return {
		messages: [
			{ role: "user", content: "touch the file", timestamp: 0 },
			toolCall,
			{
				role: "toolResult",
				toolCallId: "call_1|fc_1",
				toolName: "touch",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: 2,
			},
		],
	};
}

describe("OpenAI empty tool results", () => {
	it("does not claim an attached image in Chat Completions", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = { ...baseModel, api: "openai-completions" };
		const messages = convertMessages(model, emptyToolResultContext(model), compat);
		expect(messages.find((message) => message.role === "tool")?.content).toBe("(no output)");
	});

	it("does not claim an attached image in Responses", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		const input = convertResponsesMessages(model, emptyToolResultContext(model), new Set(["openai-codex"]));
		expect(input.find((item) => item.type === "function_call_output")).toMatchObject({ output: "(no output)" });
	});
});
