import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentTool } from "../src/index.ts";

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

	it.each([{}, { processQueuedMessagesFirst: true }])(
		"runs an unfinished restored tool call before queued steering (%o)",
		async (continueOptions) => {
			const executed: string[] = [];
			const toolSchema = Type.Object({ value: Type.String() });
			const echo: AgentTool<typeof toolSchema, undefined> = {
				name: "echo",
				label: "Echo",
				description: "Echo tool",
				parameters: toolSchema,
				async execute(_toolCallId, params) {
					executed.push(params.value);
					return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: undefined };
				},
			};
			const providerRequestRoles: string[][] = [];
			const agent = new Agent({
				initialState: { tools: [echo] },
				streamFn: (_model, context) => {
					providerRequestRoles.push(context.messages.map((message) => message.role));
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Reported") });
					});
					return stream;
				},
			});
			agent.state.messages = [
				{ role: "user", content: [{ type: "text", text: "Echo this" }], timestamp: Date.now() - 10 },
				{
					...createAssistantMessage(""),
					content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "restored" } }],
					stopReason: "toolUse",
				},
			];
			agent.steer({
				role: "user",
				content: [{ type: "text", text: "Also report the result" }],
				timestamp: Date.now(),
			});

			await agent.continue(continueOptions);

			expect(executed).toEqual(["restored"]);
			expect(providerRequestRoles).toEqual([["user", "assistant", "toolResult", "user"]]);
		},
	);

	it("starts an empty transcript from queued steering", async () => {
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
		agent.steer({ role: "user", content: [{ type: "text", text: "Idle steering" }], timestamp: Date.now() });

		await agent.continue({ processQueuedMessagesFirst: true });

		expect(providerRequestTexts).toHaveLength(1);
		expect(providerRequestTexts[0]).toContain("Idle steering");
		expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});
});
