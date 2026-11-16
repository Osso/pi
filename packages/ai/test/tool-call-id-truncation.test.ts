import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, ToolResultMessage } from "../src/types.ts";

// Google names generated tool call ids `${name}_${Date.now()}_${counter}`; with a long MCP tool name, two calls
// from one response differ only past the 40/64-character limits of other providers.
const toolName = "mcp__inventory__lookup_records_with_account_metadata";
const ids = [`${toolName}_1794672000000_1`, `${toolName}_1794672000000_2`];

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

function googleToolCallContext(): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall" as const, id, name: toolName, arguments: {} })),
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-2.5-pro",
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
	const results: ToolResultMessage[] = ids.map((id, index) => ({
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text: `result ${index + 1}` }],
		isError: false,
		timestamp: 2 + index,
	}));
	return { messages: [{ role: "user", content: "look up both", timestamp: 0 }, assistant, ...results] };
}

describe("tool call ids shortened for another provider", () => {
	// Upstream 5bdf988b7: OpenRouter received the long IDs unchanged and forwarded them to OpenAI, which rejects them.
	it.each([
		["openai", getModel("openai", "gpt-4o-mini")],
		["openrouter", getModel("openrouter", "openai/gpt-4o-mini")],
	])("stay distinct and paired with their results in Chat Completions (%s)", (_provider, sourceModel) => {
		const { compat: _compat, ...baseModel } = sourceModel;
		const model: Model<"openai-completions"> = { ...baseModel, api: "openai-completions" };
		const messages = convertMessages(model, googleToolCallContext(), compat);

		const callIds = messages.flatMap((message) =>
			message.role === "assistant" ? (message.tool_calls ?? []).map((call) => call.id) : [],
		);
		const resultIds = messages.flatMap((message) => (message.role === "tool" ? [message.tool_call_id] : []));
		expect(new Set(callIds).size).toBe(2);
		expect(resultIds).toEqual(callIds);
		expect(callIds.every((id) => id.length <= 40)).toBe(true);
	});

	it("stay distinct and paired with their results in Responses", () => {
		const model = getModel("openai", "gpt-5.5");
		const input = convertResponsesMessages(model, googleToolCallContext(), new Set(["openai"]));

		const callIds = input.flatMap((item) => (item.type === "function_call" ? [item.call_id] : []));
		const resultIds = input.flatMap((item) => (item.type === "function_call_output" ? [item.call_id] : []));
		expect(new Set(callIds).size).toBe(2);
		expect(resultIds).toEqual(callIds);
		expect(callIds.every((id) => id.length <= 64)).toBe(true);
	});
});
