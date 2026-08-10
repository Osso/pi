import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("Agent queued continuation", () => {
	it("processes an agent_end follow-up before continuing a terminal tool-result tail", async () => {
		const providerRequestTexts: string[] = [];
		const agent = new Agent({
			streamFn: (_model, context) => {
				providerRequestTexts.push(JSON.stringify(context.messages));
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Processed") });
				});
				return stream;
			},
		});
		agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "Initial" }],
				timestamp: Date.now() - 10,
			},
			{
				...createAssistantMessage(""),
				content: [{ type: "toolCall", id: "end-1", name: "end_turn", arguments: { reason: "Finished work" } }],
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "end-1",
				toolName: "end_turn",
				content: [{ type: "text", text: "Turn ended: Finished work" }],
				details: { reason: "Finished work" },
				isError: false,
				timestamp: Date.now(),
			},
		];
		agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Queued follow-up" }],
			timestamp: Date.now(),
		});

		await agent.continue({ processQueuedMessagesFirst: true });

		expect(providerRequestTexts).toHaveLength(1);
		expect(providerRequestTexts[0]).toContain("Queued follow-up");
	});
});
