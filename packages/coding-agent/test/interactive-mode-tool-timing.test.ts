import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ToolTimingContext = {
	defaultWorkingMessage: string;
	executingToolNames: Map<string, string>;
	executingToolStartedAt: Map<string, number>;
	setDefaultWorkingMessage(message: string): void;
	getThinkingWorkingMessage(): string;
	getToolWaitingMessage(toolName: string, startedAt?: number, showElapsed?: boolean): string;
	isViewingAgentSession(): boolean;
};

type HiddenToolTimingContext = ToolTimingContext & {
	currentWorkingDefaultMessage: string;
	handleHiddenMainSessionDisplayEvent(event: AgentSessionEvent): boolean;
	handleEvent(event: AgentSessionEvent): Promise<void>;
	isInitialized: boolean;
	multiAgentStore: {
		getSelectedAgentId(): string | undefined;
		getAgent(id: string): undefined;
	};
	setWorkingMessageForActiveTools(): void;
	startToolWaitingTimer(): void;
	stopToolWaitingTimerIfIdle(): void;
	syncToolExecutionTrackingForHiddenMainEvent(event: AgentSessionEvent): void;
	toolWaitingTimer: ReturnType<typeof setInterval> | undefined;
	ui: { requestRender(): void };
	workingMessage: undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	getToolWaitingMessage(this: ToolTimingContext, toolName: string, startedAt?: number, showElapsed?: boolean): string;
	getWorkingLoaderMessage(this: HiddenToolTimingContext): string;
	handleHiddenMainSessionDisplayEvent(this: HiddenToolTimingContext, event: AgentSessionEvent): boolean;
	handleEvent(this: HiddenToolTimingContext, event: AgentSessionEvent): Promise<void>;
	setDefaultWorkingMessage(this: HiddenToolTimingContext, message: string): void;
	setWorkingMessageForActiveTools(this: ToolTimingContext): void;
	startToolWaitingTimer(this: HiddenToolTimingContext): void;
	stopToolWaitingTimerIfIdle(this: HiddenToolTimingContext): void;
	syncToolExecutionTrackingForHiddenMainEvent(this: HiddenToolTimingContext, event: AgentSessionEvent): void;
};
const getToolWaitingMessage = interactiveModePrototype.getToolWaitingMessage;
const setWorkingMessageForActiveTools = interactiveModePrototype.setWorkingMessageForActiveTools;

function createContext(viewingAgent: boolean, toolName = "slow_tool"): ToolTimingContext {
	return {
		defaultWorkingMessage: "Thinking...",
		executingToolNames: new Map([["tool-1", toolName]]),
		executingToolStartedAt: new Map([["tool-1", 1_000]]),
		setDefaultWorkingMessage: vi.fn(),
		getThinkingWorkingMessage: () => "Thinking...",
		getToolWaitingMessage,
		isViewingAgentSession: () => viewingAgent,
	};
}

function createHiddenViewContext(isViewingChild: () => boolean): HiddenToolTimingContext {
	return {
		currentWorkingDefaultMessage: "Thinking... 0s",
		defaultWorkingMessage: "Thinking...",
		executingToolNames: new Map(),
		executingToolStartedAt: new Map(),
		getThinkingWorkingMessage: () => "Thinking...",
		getToolWaitingMessage,
		handleEvent: interactiveModePrototype.handleEvent,
		handleHiddenMainSessionDisplayEvent: interactiveModePrototype.handleHiddenMainSessionDisplayEvent,
		isInitialized: true,
		isViewingAgentSession: isViewingChild,
		multiAgentStore: {
			getSelectedAgentId: () => (isViewingChild() ? "child-1" : undefined),
			getAgent: () => undefined,
		},
		setDefaultWorkingMessage: interactiveModePrototype.setDefaultWorkingMessage,
		setWorkingMessageForActiveTools,
		startToolWaitingTimer: interactiveModePrototype.startToolWaitingTimer,
		stopToolWaitingTimerIfIdle: interactiveModePrototype.stopToolWaitingTimerIfIdle,
		syncToolExecutionTrackingForHiddenMainEvent: interactiveModePrototype.syncToolExecutionTrackingForHiddenMainEvent,
		toolWaitingTimer: undefined,
		ui: { requestRender: vi.fn() },
		workingMessage: undefined,
	};
}

describe("InteractiveMode tool waiting timing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("shows status elapsed for a pending child-view tool", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const fakeThis = createContext(true);

		setWorkingMessageForActiveTools.call(fakeThis);

		expect(fakeThis.setDefaultWorkingMessage).toHaveBeenCalledWith("Waiting for tool: slow_tool... 3s");
	});

	test("shows status elapsed for a pending main-view tool", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const fakeThis = createContext(false, "pyrun_eval");

		setWorkingMessageForActiveTools.call(fakeThis);

		expect(fakeThis.setDefaultWorkingMessage).toHaveBeenCalledWith("Waiting for tool: pyrun_eval... 3s");
	});

	test("shows command status elapsed without a trailing label", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const fakeThis = createContext(false, "bash");

		setWorkingMessageForActiveTools.call(fakeThis);

		expect(fakeThis.setDefaultWorkingMessage).toHaveBeenCalledWith("Waiting for command... 3s");
	});

	test("shows elapsed main-session tool status after returning from a child view", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let viewingChild = true;
		const fakeThis = createHiddenViewContext(() => viewingChild);

		try {
			await interactiveModePrototype.handleEvent.call(fakeThis, {
				type: "tool_execution_start",
				toolCallId: "bash-1",
				toolName: "bash",
				args: { command: "sleep 120" },
				startedAt: Date.now(),
			});
			vi.advanceTimersByTime(2_000);
			viewingChild = false;
			expect(interactiveModePrototype.getWorkingLoaderMessage.call(fakeThis)).toBe("Waiting for command... 2s");

			vi.advanceTimersByTime(1_000);
			expect(interactiveModePrototype.getWorkingLoaderMessage.call(fakeThis)).toBe("Waiting for command... 3s");
		} finally {
			fakeThis.executingToolNames.clear();
			interactiveModePrototype.stopToolWaitingTimerIfIdle.call(fakeThis);
		}
	});
});
