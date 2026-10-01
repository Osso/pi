import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.ts";

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

type Interruption = "steer" | "abort" | "failure";

function createInterruptionFixture() {
	const stream = new MockAssistantStream();
	const events: AgentEvent[] = [];
	let markPartialRendered = () => {};
	const partialRendered = new Promise<void>((resolve) => {
		markPartialRendered = resolve;
	});
	const toolSchema = Type.Object({});
	const tool: AgentTool<typeof toolSchema> = {
		name: "stuck_tool",
		label: "Interrupted Tool",
		description: "Must not execute an interrupted call",
		parameters: toolSchema,
		execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "unexpected execution" }], details: {} })),
	};
	const agent = new Agent({ initialState: { tools: [tool] }, streamFn: () => stream });
	agent.subscribe((event) => {
		events.push(event);
		if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta") {
			markPartialRendered();
		}
	});
	return { agent, stream, events, partialRendered, tool };
}

function pushPartialReply(stream: MockAssistantStream): AssistantMessage {
	const initial = createToolUseMessage();
	const partial: AssistantMessage = {
		...initial,
		content: [],
		timestamp: 1234,
		usage: { ...initial.usage, output: 7, totalTokens: 7 },
	};
	stream.push({ type: "start", partial });
	const thinking: AssistantMessage = {
		...partial,
		content: [{ type: "thinking", thinking: "Concrete reasoning", thinkingSignature: "reasoning-signature" }],
	};
	stream.push({ type: "thinking_delta", contentIndex: 0, delta: "Concrete reasoning", partial: thinking });
	const text: AssistantMessage = {
		...thinking,
		content: [...thinking.content, { type: "text", text: "Concrete partial reply", textSignature: "text-signature" }],
	};
	stream.push({ type: "text_delta", contentIndex: 1, delta: "Concrete partial reply", partial: text });
	const withTool: AssistantMessage = {
		...text,
		content: [...text.content, ...createToolUseMessage().content],
	};
	stream.push({ type: "toolcall_delta", contentIndex: 2, delta: "{}", partial: withTool });
	return withTool;
}

function interruptReply(agent: Agent, stream: MockAssistantStream, interruption: Interruption): void {
	if (interruption === "steer") {
		agent.steer({ role: "user", content: "Handle steering instead", timestamp: 5678 });
		return;
	}
	if (interruption === "abort") {
		agent.abort();
		return;
	}
	stream.fail(new Error("stream connection lost"));
}

function assertInterruptedReply(agent: Agent, events: AgentEvent[], expected: AssistantMessage): void {
	const starts = events.filter((event) => event.type === "message_start" && event.message.role === "assistant");
	const ends = events.filter((event) => event.type === "message_end" && event.message.role === "assistant");
	expect(starts).toHaveLength(1);
	expect(ends).toHaveLength(1);
	expect(ends[0]).toMatchObject({ message: expected });
	expect(agent.state.messages.filter((message) => message.role === "assistant")).toEqual([expected]);
	expect(starts[0]).toMatchObject({ message: { timestamp: expected.timestamp, model: expected.model } });
	expect(events.filter((event) => event.type === "turn_end")).toEqual([
		{ type: "turn_end", message: expected, toolResults: [] },
	]);
	expect(events.filter((event) => event.type === "agent_end")).toEqual([{ type: "agent_end", messages: [expected] }]);
	expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
	expect(agent.state.isStreaming).toBe(false);
	expect(agent.state.streamingMessage).toBeUndefined();
}

function mutateProviderPartial(partial: AssistantMessage): void {
	// A provider ignoring cancellation still owns and can mutate its partial.
	for (const block of partial.content) {
		if (block.type === "text") block.text = "Late provider text";
		if (block.type === "thinking") block.thinking = "Late provider reasoning";
		if (block.type === "toolCall") block.arguments = { late: true };
	}
	partial.content.push({ type: "text", text: "Late appended block" });
	partial.usage.output = 999;
}

async function continueInterruptedReply(agent: Agent, interruption: Interruption, expected: AssistantMessage) {
	if (interruption === "steer") expect(agent.hasQueuedMessages()).toBe(true);
	agent.streamFn = (_model, context) => {
		if (interruption === "steer") {
			expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "Handle steering instead" });
		} else {
			expect(context.messages.at(-1)).toEqual(expected);
		}
		const continuation = new MockAssistantStream();
		const reply = {
			...createToolUseMessage(),
			content: [{ type: "text", text: "Steering handled" }],
			stopReason: "stop",
		} satisfies AssistantMessage;
		continuation.push({ type: "done", reason: "stop", message: reply });
		return continuation;
	};
	await agent.continue();
	expect(agent.state.messages.at(-1)).toMatchObject({
		role: "assistant",
		content: [{ type: "text", text: "Steering handled" }],
		stopReason: "stop",
	});
	expect(agent.hasQueuedMessages()).toBe(false);
	expect(agent.state.messages.filter((message) => message.role === "user")).toHaveLength(
		interruption === "steer" ? 2 : 1,
	);
}

describe("Agent streamed interruption", () => {
	it.each(["steer", "abort", "failure"] as const)(
		"retains the started assistant message when a pending stream ends through %s",
		async (interruption) => {
			const { agent, stream, events, partialRendered, tool } = createInterruptionFixture();
			const prompt = agent.prompt("Start interrupted reply");
			const withTool = pushPartialReply(stream);
			await partialRendered;
			expect(agent.state.streamingMessage).toMatchObject({ content: withTool.content });
			expect(agent.state.isModelRequestActive).toBe(true);

			interruptReply(agent, stream, interruption);
			await prompt;
			const expected: AssistantMessage = {
				...structuredClone(withTool),
				stopReason: interruption === "failure" ? "error" : "aborted",
				errorMessage: interruption === "failure" ? "stream connection lost" : "Agent run aborted",
			};
			assertInterruptedReply(agent, events, expected);
			expect(tool.execute).not.toHaveBeenCalled();

			mutateProviderPartial(withTool);
			assertInterruptedReply(agent, events, expected);

			await continueInterruptedReply(agent, interruption, expected);
			expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
			expect(tool.execute).not.toHaveBeenCalled();
		},
	);
});

describe("Agent pre-stream interruption", () => {
	it.each(["abort", "failure"] as const)("finalizes %s before any assistant start", async (interruption) => {
		const stream = new MockAssistantStream();
		const events: AgentEvent[] = [];
		let markRequestStarted = () => {};
		const requestStarted = new Promise<void>((resolve) => {
			markRequestStarted = resolve;
		});
		const agent = new Agent({
			streamFn: () => {
				markRequestStarted();
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});
		const prompt = agent.prompt("Fail before response starts");
		await requestStarted;
		if (interruption === "abort") agent.abort();
		else stream.fail(new Error("request failed before start"));
		await prompt;
		expect(
			events.filter((event) => event.type === "message_start" && event.message.role === "assistant"),
		).toHaveLength(1);
		expect(events.filter((event) => event.type === "message_end" && event.message.role === "assistant")).toHaveLength(
			1,
		);
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			stopReason: interruption === "abort" ? "aborted" : "error",
		});
	});
});

describe("Agent tool abort", () => {
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
