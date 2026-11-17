import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentTool, STEERING_INTERRUPTION_NOTE } from "../src/index.ts";

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: USAGE,
		stopReason: "stop",
		timestamp: 1,
	};
}

function createStream(): EventStream<AssistantMessageEvent, AssistantMessage> {
	return new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => (event.type === "done" ? event.message : event.type === "error" ? event.error : assistant([])),
	);
}

const steering = { role: "user" as const, content: [{ type: "text" as const, text: "change course" }], timestamp: 2 };
const signedThinking = { type: "thinking" as const, thinking: "Plan A", thinkingSignature: "sig-a" };

/** First request streams a thinking block that ends only when `endThinking` is called; later requests answer "done". */
function thinkingAgent() {
	const requests: Array<{ context: Context; signal?: AbortSignal }> = [];
	let endThinking = () => {};
	const agent = new Agent({
		streamFn: (_model, context, options) => {
			requests.push({ context: structuredClone(context), signal: options?.signal });
			const stream = createStream();
			if (requests.length > 1) {
				queueMicrotask(() =>
					stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text: "done" }]) }),
				);
				return stream;
			}
			queueMicrotask(() => {
				stream.push({ type: "start", partial: assistant([]) });
				const open = assistant([{ type: "thinking", thinking: "Plan A" }]);
				stream.push({ type: "thinking_start", contentIndex: 0, partial: open });
				stream.push({ type: "thinking_delta", contentIndex: 0, delta: "Plan A", partial: open });
			});
			endThinking = () => {
				const closed = assistant([signedThinking]);
				stream.push({ type: "thinking_end", contentIndex: 0, content: "Plan A", partial: closed });
				stream.push({ type: "text_start", contentIndex: 1, partial: closed });
			};
			return stream;
		},
	});
	return { agent, requests, endThinking: () => endThinking() };
}

describe("steering during a content block", () => {
	it("waits for the thinking block to end and keeps the thinking in the next request", async () => {
		const { agent, requests, endThinking } = thinkingAgent();
		const prompt = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		agent.steer(steering);
		expect(requests[0]?.signal?.aborted).toBe(false);

		endThinking();
		await prompt;

		expect(requests[0]?.signal?.aborted).toBe(true);
		expect(requests).toHaveLength(2);
		const [, interrupted, steer] = requests[1]?.context.messages ?? [];
		expect(interrupted).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [signedThinking, { type: "text", text: STEERING_INTERRUPTION_NOTE }],
		});
		expect(steer).toMatchObject(steering);
		expect(agent.state.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "done" }] });
	});

	it("waits for a text block to end and keeps the text in the next request", async () => {
		const requests: Array<{ context: Context; signal?: AbortSignal }> = [];
		let endText = () => {};
		const agent = new Agent({
			streamFn: (_model, context, options) => {
				requests.push({ context: structuredClone(context), signal: options?.signal });
				const stream = createStream();
				if (requests.length > 1) {
					queueMicrotask(() =>
						stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text: "done" }]) }),
					);
					return stream;
				}
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant([]) });
					const open = assistant([{ type: "text", text: "Writing" }]);
					stream.push({ type: "text_start", contentIndex: 0, partial: open });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "Writing", partial: open });
				});
				endText = () => {
					const closed = assistant([{ type: "text", text: "Writing the answer" }]);
					stream.push({ type: "text_end", contentIndex: 0, content: "Writing the answer", partial: closed });
					stream.push({ type: "text_start", contentIndex: 1, partial: closed });
				};
				return stream;
			},
		});
		const prompt = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		agent.steer(steering);
		expect(requests[0]?.signal?.aborted).toBe(false);

		endText();
		await prompt;

		expect(requests[0]?.signal?.aborted).toBe(true);
		const [, interrupted, steer] = requests[1]?.context.messages ?? [];
		expect(interrupted).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [
				{ type: "text", text: "Writing the answer" },
				{ type: "text", text: STEERING_INTERRUPTION_NOTE },
			],
		});
		expect(steer).toMatchObject(steering);
	});

	it("aborts at once during a tool call, so the steered tool does not run", async () => {
		let signal: AbortSignal | undefined;
		let toolRuns = 0;
		const toolCall = { type: "toolCall" as const, id: "call-1", name: "noop", arguments: {} };
		const tool: AgentTool<ReturnType<typeof Type.Object>> = {
			name: "noop",
			label: "Noop",
			description: "Does nothing",
			parameters: Type.Object({}),
			async execute() {
				toolRuns += 1;
				return { content: [{ type: "text", text: "noop done" }], details: undefined };
			},
		};
		const agent = new Agent({
			initialState: { tools: [tool] },
			streamFn: (_model, _context, options) => {
				signal = options?.signal;
				const stream = createStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: assistant([]) });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: assistant([toolCall]) });
				});
				options?.signal?.addEventListener("abort", () =>
					stream.push({
						type: "error",
						reason: "aborted",
						error: { ...assistant([toolCall]), stopReason: "aborted" },
					}),
				);
				return stream;
			},
		});
		const prompt = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		agent.steer(steering);

		expect(signal?.aborted).toBe(true);
		await prompt;
		expect(toolRuns).toBe(0);
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("still aborts at once when steering arrives before any content block", async () => {
		let signal: AbortSignal | undefined;
		const agent = new Agent({
			streamFn: (_model, _context, options) => {
				signal = options?.signal;
				const stream = createStream();
				queueMicrotask(() => stream.push({ type: "start", partial: assistant([]) }));
				options?.signal?.addEventListener("abort", () =>
					stream.push({ type: "error", reason: "aborted", error: { ...assistant([]), stopReason: "aborted" } }),
				);
				return stream;
			},
		});
		const prompt = agent.prompt("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));

		agent.steer(steering);

		expect(signal?.aborted).toBe(true);
		await prompt;
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});
});
