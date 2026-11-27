import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, ThinkingContent } from "../src/types.ts";

interface AnthropicPayload {
	messages?: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
}

class PayloadCaptured extends Error {}

const fixture = JSON.parse(
	readFileSync(new URL("../../coding-agent/test/fixtures/anthropic-narration.json", import.meta.url), "utf8"),
) as { content: ThinkingContent[] };
const [privateThinking, narration] = fixture.content;

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-5-5",
	name: "Claude Opus",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9/anthropic",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1024,
};

function opusReply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		provider: "anthropic",
		api: "anthropic-messages",
		model: "claude-opus-5-5",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
	};
}

async function assistantPayloads(context: Context): Promise<Array<Array<Record<string, unknown>>>> {
	let payload: AnthropicPayload | undefined;
	const stream = streamSimple(model, context, {
		apiKey: "fake-key",
		onPayload: (captured) => {
			payload = captured as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!payload) throw new Error("Expected payload capture before request");
	return (payload.messages ?? [])
		.filter((message) => message.role === "assistant")
		.map((message) => message.content as Array<Record<string, unknown>>);
}

describe("Anthropic replay of signed narration", () => {
	it("adds the narration of a completed turn as text after the unchanged signed block", async () => {
		const endTurn = { type: "toolCall" as const, id: "toolu_1", name: "end_turn", arguments: { reason: "Answered" } };
		const [assistant] = await assistantPayloads({
			messages: [
				{ role: "user", content: "Should we batch deploys?", timestamp: Date.now() },
				opusReply([privateThinking, narration, endTurn], "toolUse"),
				{
					role: "toolResult",
					toolCallId: "toolu_1",
					toolName: "end_turn",
					content: [{ type: "text", text: "Turn ended: Answered" }],
					isError: false,
					timestamp: Date.now(),
				},
				{ role: "user", content: "And the cost?", timestamp: Date.now() },
			],
		});

		expect(assistant).toEqual([
			{ type: "thinking", thinking: privateThinking.thinking, signature: privateThinking.thinkingSignature },
			{ type: "thinking", thinking: narration.thinking, signature: narration.thinkingSignature },
			{ type: "text", text: narration.thinking },
			{ type: "tool_use", id: "toolu_1", name: "end_turn", input: { reason: "Answered" } },
		]);
	});

	it("leaves the current tool loop unchanged", async () => {
		const read = { type: "toolCall" as const, id: "toolu_2", name: "read", arguments: { path: "a.ts" } };
		const [assistant] = await assistantPayloads({
			messages: [
				{ role: "user", content: "Check a.ts", timestamp: Date.now() },
				opusReply([narration, read], "toolUse"),
				{
					role: "toolResult",
					toolCallId: "toolu_2",
					toolName: "read",
					content: [{ type: "text", text: "export {}" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});

		expect(assistant).toEqual([
			{ type: "thinking", thinking: narration.thinking, signature: narration.thinkingSignature },
			{ type: "tool_use", id: "toolu_2", name: "read", input: { path: "a.ts" } },
		]);
	});
});
