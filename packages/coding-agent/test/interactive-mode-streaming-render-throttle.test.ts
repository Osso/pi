import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSnapshot } from "../src/core/multi-agent-store.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type HandleEventThis = {
	chatContainer: Container;
	childActivityTimer: ReturnType<typeof setInterval> | undefined;
	compactionQueuedMessages: [];
	currentWorkingDefaultMessage: string;
	defaultWorkingMessage: string;
	executingToolNames: Map<string, string>;
	executingToolStartedAt: Map<string, number>;
	footer: { invalidate(): void };
	getMarkdownThemeWithSettings(): MarkdownTheme;
	hiddenThinkingLabel: string;
	hideThinkingBlock: boolean;
	isInitialized: boolean;
	loadingAnimation: { setMessage(message: string): void } | undefined;
	multiAgentStore:
		| {
				getAgent(agentId: string): Pick<AgentSnapshot, "currentActivity"> | undefined;
				getSelectedAgentId(): string | undefined;
		  }
		| undefined;
	pendingMessagesContainer: Container;
	pendingTools: Map<string, unknown>;
	runtimeHost: {
		session: {
			getFollowUpMessages(): string[];
			getSteeringMessages(): string[];
			retryAttempt: number;
			sessionManager: { getCwd(): string };
			settingsManager: { getImageWidthCells(): number; getShowImages(): boolean };
		};
	};
	streamingComponent: unknown;
	streamingMessage: AssistantMessage | undefined;
	thinkingFollowsTool: boolean;
	thinkingStartedAt: number | undefined;
	toolOutputExpanded: boolean;
	workingLoaderView: "main" | "child" | undefined;
	workingMessage: string | undefined;
	ui: Pick<TUI, "requestRender">;
	getRegisteredToolDefinition(): undefined;
};

type ToolExecutionStub = {
	hasElapsedTiming(): boolean;
	markExecutionStarted(startedAt: number): void;
	updateArgs(args: unknown): void;
	updateResult(result: unknown, isPartial?: boolean, finishedAt?: number): void;
};

function createToolExecutionStub(): ToolExecutionStub {
	return {
		hasElapsedTiming: () => true,
		markExecutionStarted: vi.fn(),
		updateArgs: vi.fn(),
		updateResult: vi.fn(),
	};
}

type HandleEvent = (this: HandleEventThis, event: AgentSessionEvent) => Promise<void>;

interface WorkingLoaderInternals {
	getWorkingLoaderMessage(this: unknown): string;
	startChildActivityTimer(this: unknown): void;
	stopChildActivityTimer(this: unknown): void;
}

const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
const workingLoader = InteractiveMode.prototype as unknown as WorkingLoaderInternals;

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createToolCallMessage(command: string): AssistantMessage {
	return {
		...createAssistantMessage(""),
		content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command } }],
	};
}

function createMessageUpdate(message: AssistantMessage): AgentSessionEvent {
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
	};
}

function createUserMessage(text: string): AgentSessionEvent {
	return {
		type: "message_start",
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	};
}

function createFakeInteractiveModeThis(): HandleEventThis {
	return Object.assign(Object.create(InteractiveMode.prototype) as HandleEventThis, {
		chatContainer: new Container(),
		childActivityTimer: undefined,
		compactionQueuedMessages: [],
		currentWorkingDefaultMessage: "Thinking...",
		defaultWorkingMessage: "Thinking...",
		executingToolNames: new Map<string, string>(),
		executingToolStartedAt: new Map<string, number>(),
		completedToolTimings: new Map<string, { startedAt: number; finishedAt: number }>(),
		footer: { invalidate: vi.fn() },
		getMarkdownThemeWithSettings: getMarkdownTheme,
		hiddenThinkingLabel: "Thinking...",
		hideThinkingBlock: false,
		isInitialized: true,
		loadingAnimation: undefined,
		multiAgentStore: undefined,
		pendingMessagesContainer: new Container(),
		pendingTools: new Map<string, unknown>(),
		runtimeHost: {
			session: {
				getFollowUpMessages: () => [],
				getSteeringMessages: () => [],
				retryAttempt: 0,
				sessionManager: { getCwd: () => process.cwd() },
				settingsManager: { getImageWidthCells: () => 40, getShowImages: () => false },
			},
		},
		streamingComponent: undefined,
		streamingMessage: undefined,
		thinkingFollowsTool: false,
		thinkingStartedAt: undefined,
		toolOutputExpanded: false,
		workingLoaderView: undefined,
		workingMessage: undefined,
		ui: { requestRender: vi.fn() },
		getRegisteredToolDefinition: () => undefined,
	});
}

describe("InteractiveMode streaming render throttling", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("does not append main session messages while viewing an agent", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.multiAgentStore = { getAgent: () => ({}), getSelectedAgentId: () => "agent_1" };
		fakeThis.chatContainer.addChild(new Text("child backlog", 0, 0));

		await handleEvent.call(fakeThis, createUserMessage("main thread leak"));

		expect(fakeThis.chatContainer.render(80).join("\n")).toContain("child backlog");
		expect(fakeThis.chatContainer.render(80).join("\n")).not.toContain("main thread leak");
	});

	test("coalesces rapid assistant message updates into one delayed render", async () => {
		vi.useFakeTimers();
		const fakeThis = createFakeInteractiveModeThis();
		const initialMessage = createAssistantMessage("");

		await handleEvent.call(fakeThis, { type: "message_start", message: initialMessage });
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		await handleEvent.call(fakeThis, createMessageUpdate(createAssistantMessage("h")));
		await handleEvent.call(fakeThis, createMessageUpdate(createAssistantMessage("he")));
		await handleEvent.call(fakeThis, createMessageUpdate(createAssistantMessage("hel")));

		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(49);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	test("message end renders immediately and leaves no delayed render pending", async () => {
		vi.useFakeTimers();
		const fakeThis = createFakeInteractiveModeThis();
		const initialMessage = createAssistantMessage("");

		await handleEvent.call(fakeThis, { type: "message_start", message: initialMessage });
		await handleEvent.call(fakeThis, createMessageUpdate(createAssistantMessage("partial")));
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		await handleEvent.call(fakeThis, { type: "message_end", message: createAssistantMessage("final") });
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(50);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	test("renders completed thinking time between consecutive tool calls", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.thinkingStartedAt = 1_000;
		fakeThis.thinkingFollowsTool = true;

		await handleEvent.call(fakeThis, { type: "message_start", message: createAssistantMessage("") });
		vi.setSystemTime(3_400);
		await handleEvent.call(fakeThis, { type: "message_end", message: createToolCallMessage("next command") });

		const rendered = fakeThis.chatContainer.render(120).join("\n");
		expect(rendered).toContain("Thought for 2s");
		expect(rendered.indexOf("Thought for 2s")).toBeLessThan(rendered.indexOf("next command"));
		expect(fakeThis.thinkingFollowsTool).toBe(false);
	});

	test("renders final tool call arguments without streaming partial arguments", async () => {
		vi.useFakeTimers();
		const fakeThis = createFakeInteractiveModeThis();
		const initialMessage = createAssistantMessage("");
		const finalToolCallMessage = createToolCallMessage(
			"git diff -- packages/coding-agent/src/modes/interactive/interactive-mode.ts",
		);

		await handleEvent.call(fakeThis, { type: "message_start", message: initialMessage });
		await handleEvent.call(fakeThis, createMessageUpdate(createToolCallMessage("git di")));
		await vi.advanceTimersByTimeAsync(50);

		expect(fakeThis.chatContainer.render(80).join("\n")).not.toContain("git di");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);

		await handleEvent.call(fakeThis, { type: "message_end", message: finalToolCallMessage });

		expect(fakeThis.chatContainer.render(120).join("\n")).toContain("git diff --");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(4);
	});

	test("coalesces rapid partial updates across tools", async () => {
		vi.useFakeTimers();
		const fakeThis = createFakeInteractiveModeThis();
		const firstTool = createToolExecutionStub();
		const secondTool = createToolExecutionStub();
		fakeThis.pendingTools.set("tool-1", firstTool);
		fakeThis.pendingTools.set("tool-2", secondTool);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "README.md" },
			partialResult: { content: [{ type: "text", text: "one" }] },
		});
		await handleEvent.call(fakeThis, {
			type: "tool_execution_update",
			toolCallId: "tool-2",
			toolName: "bash",
			args: { command: "echo two" },
			partialResult: { content: [{ type: "text", text: "two" }] },
		});
		await handleEvent.call(fakeThis, {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "README.md" },
			partialResult: { content: [{ type: "text", text: "latest" }] },
		});

		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
		expect(fakeThis.footer.invalidate).not.toHaveBeenCalled();
		expect(firstTool.updateResult).toHaveBeenLastCalledWith(
			{ content: [{ type: "text", text: "latest" }], isError: false },
			true,
		);

		await vi.advanceTimersByTimeAsync(49);
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("tool completion replaces a pending partial render with one immediate final render", async () => {
		vi.useFakeTimers();
		const fakeThis = createFakeInteractiveModeThis();
		const tool = createToolExecutionStub();
		fakeThis.pendingTools.set("tool-1", tool);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "README.md" },
			partialResult: { content: [{ type: "text", text: "partial" }] },
		});
		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "final" }] },
			isError: false,
			startedAt: 1_000,
			finishedAt: 2_000,
		});

		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
		expect(tool.updateResult).toHaveBeenLastCalledWith(
			{
				content: [{ type: "text", text: "final" }],
				isError: false,
			},
			false,
			2_000,
		);

		await vi.advanceTimersByTimeAsync(50);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("renders invalidated footer after bash messages enter session context", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const event = {
			type: "bash_messages_committed",
			messages: [{ role: "bashExecution", excludeFromContext: false }],
		} as unknown as AgentSessionEvent;

		await handleEvent.call(fakeThis, event);

		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("keeps footer cache when committed bash messages are excluded from context", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const event = {
			type: "bash_messages_committed",
			messages: [{ role: "bashExecution", excludeFromContext: true }],
		} as unknown as AgentSessionEvent;

		await handleEvent.call(fakeThis, event);

		expect(fakeThis.footer.invalidate).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});

	test("uses clearer waiting labels while tools execute", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fakeThis = createFakeInteractiveModeThis();
		const setMessage = vi.fn();
		fakeThis.loadingAnimation = { setMessage };
		fakeThis.pendingTools.set("bash-1", createToolExecutionStub());
		fakeThis.pendingTools.set("read-1", createToolExecutionStub());

		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolName: "bash",
			toolCallId: "bash-1",
			args: { command: "echo hi" },
			startedAt: 1_000,
		});
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for command...");

		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolName: "read",
			toolCallId: "read-1",
			args: { path: "README.md" },
			startedAt: 1_000,
		});
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for command...");

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "hi" }] },
			isError: false,
			startedAt: 1_000,
			finishedAt: 2_000,
		});
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for tool: read...");

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "contents" }] },
			isError: false,
			startedAt: 1_000,
			finishedAt: 2_000,
		});
		expect(setMessage).toHaveBeenLastCalledWith("Thinking...");
	});

	test("keeps elapsed time out of waiting labels when a rendered tool row exists", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fakeThis = createFakeInteractiveModeThis();
		const setMessage = vi.fn();
		fakeThis.loadingAnimation = { setMessage };

		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolName: "pyrun_eval",
			toolCallId: "pyrun-1",
			args: { code: "print(1)" },
			startedAt: 0,
		});
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for tool: pyrun_eval...");

		await vi.advanceTimersByTimeAsync(999);
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for tool: pyrun_eval...");

		await vi.advanceTimersByTimeAsync(47_001);
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for tool: pyrun_eval...");
	});

	test("keeps elapsed time out of wait_agents waiting labels", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fakeThis = createFakeInteractiveModeThis();
		const setMessage = vi.fn();
		fakeThis.loadingAnimation = { setMessage };
		fakeThis.pendingTools.set("wait-1", createToolExecutionStub());

		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolName: "wait_agents",
			toolCallId: "wait-1",
			args: { agentId: "agent_1" },
			startedAt: 0,
		});
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for tool: wait_agents...");

		await vi.advanceTimersByTimeAsync(1_000);
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for tool: wait_agents...");
	});

	test("clears main session tool waiting state while viewing an agent session", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const setMessage = vi.fn();
		fakeThis.loadingAnimation = { setMessage };

		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolName: "bash",
			toolCallId: "bash-1",
			args: { command: "sleep 120" },
			startedAt: Date.now(),
		});
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for command...");

		fakeThis.multiAgentStore = { getAgent: () => ({}), getSelectedAgentId: () => "agent_1" };
		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "Command moved to background as job agent_1" }] },
			isError: false,
			startedAt: 1_000,
			finishedAt: 2_000,
		});

		expect(fakeThis.executingToolNames.has("bash-1")).toBe(false);
		expect(setMessage).toHaveBeenLastCalledWith("Thinking...");
	});

	test("uses the configured working message in the main view", () => {
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.workingMessage = "Custom extension label";

		expect(workingLoader.getWorkingLoaderMessage.call(fakeThis)).toBe("Custom extension label");
	});

	test.each([undefined, { phase: "thinking" as const, startedAt: "invalid" }])(
		"uses a phase-neutral label for missing or invalid selected-child activity",
		(currentActivity) => {
			const fakeThis = createFakeInteractiveModeThis();
			fakeThis.multiAgentStore = {
				getAgent: () => ({ currentActivity }),
				getSelectedAgentId: () => "agent_1",
			};

			expect(workingLoader.getWorkingLoaderMessage.call(fakeThis)).toBe("Working...");
		},
	);

	test("uses selected child activity timing without leaking the main working override", () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-07-13T12:00:05.000Z");
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.multiAgentStore = {
			getAgent: () => ({ currentActivity: { phase: "thinking", startedAt: "2026-07-13T12:00:00.000Z" } }),
			getSelectedAgentId: () => "agent_1",
		};
		fakeThis.workingMessage = "Custom extension label";

		expect(workingLoader.getWorkingLoaderMessage.call(fakeThis)).toBe("Thinking... 5s");
	});

	test("updates selected child activity elapsed time locally", async () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-07-13T12:00:05.000Z");
		const fakeThis = createFakeInteractiveModeThis();
		const setMessage = vi.fn();
		fakeThis.loadingAnimation = { setMessage };
		fakeThis.workingLoaderView = "child";
		fakeThis.multiAgentStore = {
			getAgent: () => ({ currentActivity: { phase: "thinking", startedAt: "2026-07-13T12:00:00.000Z" } }),
			getSelectedAgentId: () => "agent_1",
		};

		workingLoader.startChildActivityTimer.call(fakeThis);
		await vi.advanceTimersByTimeAsync(1_000);

		expect(setMessage).toHaveBeenLastCalledWith("Thinking... 6s");
		workingLoader.stopChildActivityTimer.call(fakeThis);
		expect(fakeThis.childActivityTimer).toBeUndefined();
	});

	test("shows selected child tool activity timing", () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-07-13T12:00:05.000Z");
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.multiAgentStore = {
			getAgent: () => ({
				currentActivity: {
					phase: "tool",
					startedAt: "2026-07-13T12:00:00.000Z",
					toolCallId: "read-1",
					toolName: "read",
				},
			}),
			getSelectedAgentId: () => "agent_1",
		};

		expect(workingLoader.getWorkingLoaderMessage.call(fakeThis)).toBe("Waiting for tool: read... Elapsed: 5s");
	});

	test("keeps extension working message override during tool execution", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const setMessage = vi.fn();
		fakeThis.loadingAnimation = { setMessage };
		fakeThis.workingMessage = "Custom extension label";
		fakeThis.pendingTools.set("tool-1", createToolExecutionStub());

		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolName: "read",
			toolCallId: "tool-1",
			args: { path: "README.md" },
			startedAt: 1_000,
		});

		expect(setMessage).not.toHaveBeenCalled();
	});
});
