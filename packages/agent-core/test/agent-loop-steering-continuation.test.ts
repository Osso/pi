import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentTool } from "../src/types.ts";

function createResponseStream(model: Model<"openai-responses">, requestNumber: number) {
	const finishing = requestNumber === 3;
	const response: AssistantMessage = {
		role: "assistant",
		content: finishing
			? [{ type: "toolCall", id: "end", name: "end_turn", arguments: {} }]
			: [{ type: "text", text: requestNumber === 1 ? "First fixed." : "Final queued message fixed." }],
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
		stopReason: finishing ? "toolUse" : "stop",
		timestamp: 3,
	};
	const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done",
		() => response,
	);
	stream.push({ type: "done", reason: finishing ? "toolUse" : "stop", message: response });
	stream.end(response);
	return stream;
}

it("lets steering at text-only turn end supersede the previous completion instruction", async () => {
	const model: Model<"openai-responses"> = {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
	const steering: UserMessage = { role: "user", content: "Also fix the final queued message.", timestamp: 2 };
	const queued: UserMessage[] = [];
	const requests: Message[][] = [];
	const endTurn: AgentTool = {
		name: "end_turn",
		label: "End turn",
		description: "Finish the current turn",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {}, terminate: true }),
	};
	let steered = false;
	const messages = await runAgentLoop(
		[{ role: "user", content: "Fix the first message.", timestamp: 1 }],
		{ systemPrompt: "Follow user requests.", messages: [], tools: [endTurn] },
		{
			model,
			convertToLlm: (messages) =>
				messages.filter(
					(message): message is Message =>
						message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				),
			getSteeringMessages: async () => queued.splice(0),
		},
		(event) => {
			if (event.type === "turn_end" && !steered) {
				steered = true;
				queued.push(steering);
			}
		},
		undefined,
		(_model, context) => {
			requests.push([...context.messages]);
			return createResponseStream(model, requests.length);
		},
	);

	expect(requests).toHaveLength(3);
	expect(requests[1].at(-1)).toEqual(steering);
	expect(requests[1].filter((message) => message.role === "user")).toHaveLength(2);
	expect(requests[2].at(-1)).toMatchObject({
		role: "user",
		content:
			"Your previous response was already delivered. Do not continue, repeat, or infer a new user request. Call `end_turn` now with a concise reason.",
	});
	expect(messages.filter((message) => message.role === "user")).toEqual([
		{ role: "user", content: "Fix the first message.", timestamp: 1 },
		steering,
	]);
});
