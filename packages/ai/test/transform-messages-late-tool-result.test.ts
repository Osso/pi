import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/google-shared.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Context, Message, Model, ToolResultMessage } from "../src/types.ts";

const model: Model<"google-generative-ai"> = {
	id: "gemini-2.5-flash",
	name: "Gemini 2.5 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 65536,
};

const toolBatch: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.txt" } },
		{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b.txt" } },
	],
	api: "google-generative-ai",
	provider: "google",
	model: "gemini-2.5-flash",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 2,
};

function readResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

/** Result b was stored after the user message that interrupted the batch. */
const interruptedBatch: Message[] = [
	{ role: "user", content: "read both files", timestamp: 1 },
	toolBatch,
	readResult("call_a", "contents of a"),
	{ role: "user", content: "stop and summarize", timestamp: 4 },
	readResult("call_b", "contents of b"),
];

describe("transformMessages with a tool result stored after an interrupting user message", () => {
	it("moves the late result before the user message instead of adding a synthetic one", () => {
		const transformed = transformMessages(interruptedBatch, model);

		expect(
			transformed.map((message) =>
				message.role === "toolResult"
					? `toolResult ${message.toolCallId}: ${message.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`
					: message.role,
			),
		).toEqual(["user", "assistant", "toolResult call_a: contents of a", "toolResult call_b: contents of b", "user"]);
	});

	it("sends each function call one Google function response", () => {
		const context: Context = { messages: interruptedBatch };
		const responses = convertMessages(model, context).flatMap((content) =>
			(content.parts ?? []).flatMap((part) => (part.functionResponse ? [part.functionResponse.response] : [])),
		);

		expect(responses).toEqual([{ output: "contents of a" }, { output: "contents of b" }]);
	});
});
