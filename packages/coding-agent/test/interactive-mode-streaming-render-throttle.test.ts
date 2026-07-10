import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
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
	multiAgentStore: { getSelectedAgentId(): string | undefined } | undefined;
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
	toolOutputExpanded: boolean;
	workingMessage: string | undefined;
	ui: Pick<TUI, "requestRender">;
	getRegisteredToolDefinition(): undefined;
};

type ToolExecutionStub = {
	markExecutionStarted(): void;
	updateArgs(args: unknown): void;
	updateResult(result: unknown, isPartial?: boolean): void;
};

function createToolExecutionStub(): ToolExecutionStub {
	return {
		markExecutionStarted: vi.fn(),
		updateArgs: vi.fn(),
		updateResult: vi.fn(),
	};
}

type HandleEvent = (this: HandleEventThis, event: AgentSessionEvent) => Promise<void>;

const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

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
		compactionQueuedMessages: [],
		currentWorkingDefaultMessage: "Thinking...",
		defaultWorkingMessage: "Thinking...",
		executingToolNames: new Map<string, string>(),
		executingToolStartedAt: new Map<string, number>(),
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
		toolOutputExpanded: false,
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
		fakeThis.multiAgentStore = { getSelectedAgentId: () => "agent_1" };
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

		await vi.advanceTimersByTimeAsync(50);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
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

	test("uses clearer waiting labels while tools execute", async () => {
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
		});
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for command...");

		await handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolName: "read",
			toolCallId: "read-1",
			args: { path: "README.md" },
		});
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for command...");

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "hi" }] },
			isError: false,
		});
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for tool: read...");

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "contents" }] },
			isError: false,
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
		});
		expect(setMessage).toHaveBeenLastCalledWith("Waiting for command...");

		fakeThis.multiAgentStore = { getSelectedAgentId: () => "agent_1" };
		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: "bash-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "Command moved to background as job agent_1" }] },
			isError: false,
		});

		expect(fakeThis.executingToolNames.has("bash-1")).toBe(false);
		expect(setMessage).toHaveBeenLastCalledWith("Thinking...");
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
		});

		expect(setMessage).not.toHaveBeenCalled();
	});
});
