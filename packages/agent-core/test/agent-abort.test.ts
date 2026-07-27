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

function createToolUseMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "stuck_tool", arguments: {} }],
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
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("Agent abort", () => {
	it("settles when the active tool ignores its abort signal", async () => {
		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const toolSchema = Type.Object({});
		const stuckTool: AgentTool<typeof toolSchema> = {
			name: "stuck_tool",
			label: "Stuck Tool",
			description: "Never settles",
			parameters: toolSchema,
			execute: async (): Promise<never> => {
				markToolStarted();
				return await new Promise<never>(() => undefined);
			},
		};
		const agent = new Agent({
			initialState: { tools: [stuckTool] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "toolUse", message: createToolUseMessage() });
				});
				return stream;
			},
		});

		const prompt = agent.prompt("run stuck tool");
		await toolStarted;
		agent.abort();

		const settlement = await Promise.race([
			prompt.then(() => "settled" as const),
			new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 50)),
		]);
		expect(settlement).toBe("settled");
		expect(agent.state.isStreaming).toBe(false);
	});
});
