import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { getControlDbPath } from "../src/core/session-control-db.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createHarness } from "./suite/harness.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: AgentMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	services: { agentDir: string };
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
	endTurn?: boolean;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [
			...(options?.text ? [{ type: "text" as const, text: options.text }] : []),
			...(options?.endTurn
				? [{ type: "toolCall" as const, id: "finish", name: "end_turn", arguments: { reason: "finished" } }]
				: []),
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(messages: AssistantMessage | AgentMessage[]): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: Array.isArray(messages) ? messages : [messages] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		services: { agentDir: join("/tmp", "pi-print-mode-agent") },
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

function captureStdout(): string[] {
	const output: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(
		(
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			output.push(String(chunk));
			if (typeof encodingOrCallback === "function") encodingOrCallback();
			else callback?.();
			return true;
		},
	);
	return output;
}

async function captureJsonEvents(events: AgentSessionEvent[]): Promise<Record<string, unknown>[]> {
	const output = captureStdout();
	const runtimeHost = createRuntimeHost([]);
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	runtimeHost.session.subscribe.mockImplementation((callback: (event: AgentSessionEvent) => void) => {
		listener = callback;
		return () => {};
	});
	runtimeHost.session.prompt.mockImplementation(async () => {
		if (!listener) throw new Error("Print mode did not subscribe");
		for (const event of events) listener(event);
	});
	const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
		mode: "json",
		initialMessage: "emit fixtures",
	});
	expect(exitCode).toBe(0);
	return output
		.join("")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("print-mode JSON wire output", () => {
	it("emits deltas and content boundaries without accumulated or completed bodies", async () => {
		const message = createAssistantMessage({ text: "complete text" });
		const toolCall = {
			type: "toolCall" as const,
			id: "lookup-1",
			name: "lookup",
			arguments: { query: "complete args" },
		};
		message.content.push({ type: "thinking", thinking: "complete thinking" }, toolCall);
		const providerEvents: AssistantMessageEvent[] = [
			{ type: "text_start", contentIndex: 0, partial: message },
			{ type: "text_delta", contentIndex: 0, delta: "text chunk", partial: message },
			{ type: "text_end", contentIndex: 0, content: "complete text", partial: message },
			{ type: "thinking_start", contentIndex: 1, partial: message },
			{ type: "thinking_delta", contentIndex: 1, delta: "thinking chunk", partial: message },
			{ type: "thinking_end", contentIndex: 1, content: "complete thinking", partial: message },
			{ type: "toolcall_start", contentIndex: 2, partial: message },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"query":', partial: message },
			{ type: "toolcall_end", contentIndex: 2, toolCall, partial: message },
		];
		const events: AgentSessionEvent[] = providerEvents.map((assistantMessageEvent) => ({
			type: "message_update",
			message,
			assistantMessageEvent,
			runtimeMessageMarker: "duplicate_turn_assistant",
		}));
		const originals = structuredClone(events);
		const output = await captureJsonEvents(events);
		expect(output).toEqual(
			providerEvents.map((event) => ({
				type: "message_update",
				runtimeMessageMarker: "duplicate_turn_assistant",
				assistantMessageEvent: {
					type: event.type,
					...("contentIndex" in event ? { contentIndex: event.contentIndex } : {}),
					...("delta" in event ? { delta: event.delta } : {}),
				},
			})),
		);
		expect(events).toEqual(originals);
	});

	it("emits user, assistant, and tool bodies only at message_end", async () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "private user body" },
					{ type: "image", mimeType: "image/png", data: "user-image" },
				],
				inputSource: "rpc",
				timestamp: 1,
			},
			createAssistantMessage({ text: "completed answer" }),
			{
				role: "toolResult",
				toolCallId: "lookup-1",
				toolName: "lookup",
				content: [
					{ type: "text", text: "tool body" },
					{ type: "image", mimeType: "image/png", data: "tool-image" },
				],
				details: { rows: ["large detail body"] },
				isError: false,
				timestamp: 2,
			},
			{
				role: "custom",
				customType: "note",
				content: "custom body",
				display: true,
				details: { body: "custom details" },
				timestamp: 3,
			},
			{ role: "branchSummary", summary: "branch body", fromId: "entry-1", timestamp: 4 },
		];
		const events: AgentSessionEvent[] = messages.flatMap((message) => [
			{ type: "message_start" as const, message },
			{ type: "message_end" as const, message },
		]);
		const originals = structuredClone(events);
		const output = await captureJsonEvents(events);
		for (const [index, message] of messages.entries()) {
			const bodyFields = new Set(["content", "details", "summary"]);
			const metadata = Object.fromEntries(Object.entries(message).filter(([key]) => !bodyFields.has(key)));
			expect(output[index * 2]).toEqual({ type: "message_start", message: JSON.parse(JSON.stringify(metadata)) });
			expect(output[index * 2 + 1]).toEqual(JSON.parse(JSON.stringify({ type: "message_end", message })));
		}
		expect(events).toEqual(originals);
	});

	it.each(["error", "aborted"] as const)(
		"retains %s message and retry/continuation metadata without terminal copies",
		async (stopReason) => {
			const message = createAssistantMessage({
				text: "partial answer",
				stopReason,
				errorMessage: "provider failed",
			});
			message.responseId = "response-1";
			const events: AgentSessionEvent[] = [
				{ type: "message_end", message },
				{ type: "turn_end", message, toolResults: [] },
				{ type: "agent_end", messages: [message], willRetry: true, sessionContinuation: "cwd_relocation" },
				{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "provider failed" },
				{ type: "auto_retry_end", success: false, attempt: 3, finalError: "still failed" },
			];
			const output = await captureJsonEvents(events);
			expect(output).toEqual([
				JSON.parse(JSON.stringify(events[0])),
				{ type: "turn_end" },
				{ type: "agent_end", willRetry: true, sessionContinuation: "cwd_relocation" },
				events[3],
				events[4],
			]);
		},
	);

	it("preserves nonduplicated execution fields and leaves tool progress and bash messages intact", async () => {
		const result = {
			content: [{ type: "text" as const, text: "tool body" }],
			details: { rows: ["tool details"] },
			terminate: true,
			isError: true,
			executionId: "execution-1",
		};
		const toolMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "lookup-1",
			toolName: "lookup",
			content: result.content,
			details: result.details,
			isError: true,
			timestamp: 30,
		};
		const events: AgentSessionEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "lookup-1",
				toolName: "lookup",
				args: { query: "input" },
				startedAt: 10,
			},
			{
				type: "tool_execution_update",
				toolCallId: "lookup-1",
				toolName: "lookup",
				args: { query: "input" },
				partialResult: { content: [{ type: "text", text: "live progress" }], details: { progress: 50 } },
			},
			{
				type: "tool_execution_end",
				toolCallId: "lookup-1",
				toolName: "lookup",
				result,
				isError: true,
				startedAt: 10,
				finishedAt: 20,
			},
			{ type: "message_start", message: toolMessage },
			{ type: "message_end", message: toolMessage },
			{
				type: "bash_messages_committed",
				messages: [
					{
						role: "bashExecution",
						command: "pwd",
						output: "/workspace",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						timestamp: 40,
					},
				],
			},
		];
		const originals = structuredClone(events);
		const output = await captureJsonEvents(events);
		expect(output[0]).toEqual(events[0]);
		expect(output[1]).toEqual(events[1]);
		expect(output[2]).toEqual({
			...events[2],
			result: { terminate: true, isError: true, executionId: "execution-1" },
		});
		expect(output[3]).toEqual({
			type: "message_start",
			message: { role: "toolResult", toolCallId: "lookup-1", toolName: "lookup", isError: true, timestamp: 30 },
		});
		expect(output[4]).toEqual(events[4]);
		expect(output[5]).toEqual(events[5]);
		expect(events).toEqual(originals);
	});

	it("scales linearly with emitted deltas rather than accumulated snapshots", async () => {
		const captureSize = async (count: number): Promise<number> => {
			const events: AgentSessionEvent[] = Array.from({ length: count }, (_, index) => {
				const message = createAssistantMessage({ text: "x".repeat(index + 1) });
				return {
					type: "message_update",
					message,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
				};
			});
			events.push({ type: "message_end", message: createAssistantMessage({ text: "x".repeat(count) }) });
			const output = await captureJsonEvents(events);
			return Buffer.byteLength(output.map((event) => JSON.stringify(event)).join("\n"));
		};
		const small = await captureSize(1000);
		const large = await captureSize(2000);
		expect(large).toBeGreaterThan(small * 1.9);
		expect(large).toBeLessThan(small * 2.1);
	});

	it("serializes a real faux-provider tool turn without modifying session events", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "lookup",
					label: "Lookup",
					description: "Fixture lookup",
					parameters: Type.Object({ query: Type.String() }),
					execute: async () => ({
						content: [{ type: "text", text: "lookup result" }],
						details: { rows: [42] },
						terminate: true,
					}),
				},
			],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxThinking("reasoning body"),
						fauxText("calling lookup"),
						fauxToolCall("lookup", { query: "fixture query" }, { id: "lookup-1" }),
					],
					{ stopReason: "toolUse" },
				),
			]);
			const output = captureStdout();
			const runtimeHost = { ...createRuntimeHost([]), session: harness.session, dispose: vi.fn(async () => {}) };
			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "json",
				initialMessage: "fixture question",
			});
			expect(exitCode).toBe(0);
			const wire = output
				.join("")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const completedLines = output
				.join("")
				.trim()
				.split("\n")
				.filter((line) => line.startsWith('{"type":"message_end"'));
			expect(completedLines).toEqual(harness.eventsOfType("message_end").map((event) => JSON.stringify(event)));
			expect(
				completedLines.some((line) => line.startsWith('{"type":"message_end","message":{"role":"assistant"')),
			).toBe(true);
			const ends = wire.filter((event) => event.type === "message_end");
			expect(ends.map((event) => event.message)).toEqual(
				JSON.parse(JSON.stringify(harness.eventsOfType("message_end").map((event) => event.message))),
			);
			expect(ends).toHaveLength(3);
			expect(harness.faux.state.callCount).toBe(1);
			const updates = wire.filter((event) => event.type === "message_update");
			expect(updates.length).toBeGreaterThan(0);
			for (const event of updates) {
				expect(event).not.toHaveProperty("message");
				expect(event.assistantMessageEvent).not.toHaveProperty("partial");
			}
			const executionIndex = wire.findIndex((event) => event.type === "tool_execution_end");
			const resultIndex = wire.findIndex(
				(event) => event.type === "message_end" && (event.message as AgentMessage).role === "toolResult",
			);
			expect(executionIndex).toBeLessThan(resultIndex);
			expect(wire[executionIndex]).toMatchObject({
				toolCallId: "lookup-1",
				toolName: "lookup",
				isError: false,
				result: { terminate: true },
			});
			expect(wire[executionIndex].result).not.toHaveProperty("content");
			expect(wire[executionIndex].result).not.toHaveProperty("details");
			expect(harness.eventsOfType("tool_execution_end")[0].result).toMatchObject({
				content: [{ type: "text", text: "lookup result" }],
				details: { rows: [42] },
			});
			expect(harness.eventsOfType("message_update")[0]).toHaveProperty("assistantMessageEvent.partial");
			const agentEnd = wire.find((event) => event.type === "agent_end");
			expect(agentEnd).toHaveProperty("willRetry", false);
			expect(agentEnd).not.toHaveProperty("messages");
		} finally {
			harness.cleanup();
		}
	});
});

describe("runPrintMode", () => {
	it("binds the control database path for runtime mailbox draining", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(session.bindExtensions).toHaveBeenCalledWith(
			expect.objectContaining({
				controlDbPath: getControlDbPath(),
			}),
		);
	});

	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("prints an ordinary final assistant response", async () => {
		const output = captureStdout();
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "ordinary answer" }));
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});
		expect(exitCode).toBe(0);
		expect(output.join("")).toBe("ordinary answer\n");
	});

	it("prints the last answer before a terminating tool result", async () => {
		const output = captureStdout();
		const runtimeHost = createRuntimeHost([
			{ role: "user", content: "question", timestamp: 1 },
			createAssistantMessage({ text: "final answer", stopReason: "toolUse", endTurn: true }),
			{ role: "toolResult", toolCallId: "finish", toolName: "end_turn", content: [], isError: false, timestamp: 2 },
		]);
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});
		expect(exitCode).toBe(0);
		expect(output.join("")).toBe("final answer\n");
	});

	it("prints a separate answer before a textless end_turn assistant", async () => {
		const output = captureStdout();
		const runtimeHost = createRuntimeHost([
			{ role: "user", content: "question", timestamp: 1 },
			createAssistantMessage({ text: "final answer" }),
			createAssistantMessage({ stopReason: "toolUse", endTurn: true }),
			{ role: "toolResult", toolCallId: "finish", toolName: "end_turn", content: [], isError: false, timestamp: 2 },
		]);
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});
		expect(exitCode).toBe(0);
		expect(output.join("")).toBe("final answer\n");
	});

	it("does not print intermediate tool chatter as the final answer", async () => {
		const output = captureStdout();
		const runtimeHost = createRuntimeHost([
			{ role: "user", content: "question", timestamp: 1 },
			createAssistantMessage({ text: "running a tool", stopReason: "toolUse" }),
			{ role: "toolResult", toolCallId: "other", toolName: "read", content: [], isError: false, timestamp: 2 },
			createAssistantMessage({ stopReason: "toolUse", endTurn: true }),
			{ role: "toolResult", toolCallId: "finish", toolName: "end_turn", content: [], isError: false, timestamp: 3 },
		]);
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});
		expect(exitCode).toBe(0);
		expect(output.join("")).toBe("");
	});

	it("does not print an answer from an earlier prompt", async () => {
		const output = captureStdout();
		const runtimeHost = createRuntimeHost([
			{ role: "user", content: "first", timestamp: 1 },
			createAssistantMessage({ text: "old answer" }),
			{ role: "user", content: "second", timestamp: 2 },
			createAssistantMessage({ stopReason: "toolUse", endTurn: true }),
			{ role: "toolResult", toolCallId: "finish", toolName: "end_turn", content: [], isError: false, timestamp: 3 },
		]);
		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});
		expect(exitCode).toBe(0);
		expect(output.join("")).toBe("");
	});

	it.each(["error", "aborted"] as const)(
		"reports a trailing %s without printing the earlier answer",
		async (stopReason) => {
			const output = captureStdout();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const runtimeHost = createRuntimeHost([
				{ role: "user", content: "question", timestamp: 1 },
				createAssistantMessage({ text: "earlier answer" }),
				createAssistantMessage({ stopReason, errorMessage: "latest failure" }),
			]);
			const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
			});
			expect(exitCode).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith("latest failure");
			expect(output.join("")).toBe("");
		},
	);
});
