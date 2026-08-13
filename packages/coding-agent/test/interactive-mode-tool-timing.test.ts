import { afterEach, describe, expect, test, vi } from "vitest";
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

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	getToolWaitingMessage(this: ToolTimingContext, toolName: string, startedAt?: number, showElapsed?: boolean): string;
	setWorkingMessageForActiveTools(this: ToolTimingContext): void;
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

describe("InteractiveMode tool waiting timing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("shows status elapsed for a pending child-view tool", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const fakeThis = createContext(true);

		setWorkingMessageForActiveTools.call(fakeThis);

		expect(fakeThis.setDefaultWorkingMessage).toHaveBeenCalledWith("Waiting for tool: slow_tool... Elapsed: 3s");
	});

	test("shows status elapsed for a pending main-view tool", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const fakeThis = createContext(false, "pyrun_eval");

		setWorkingMessageForActiveTools.call(fakeThis);

		expect(fakeThis.setDefaultWorkingMessage).toHaveBeenCalledWith("Waiting for tool: pyrun_eval... Elapsed: 3s");
	});
});
