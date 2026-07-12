import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ToolTimingContext = {
	defaultWorkingMessage: string;
	executingToolNames: Map<string, string>;
	executingToolStartedAt: Map<string, number>;
	pendingTools: Map<string, unknown>;
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

describe("InteractiveMode tool waiting timing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("shows elapsed time for a reconstructed pending child-view tool", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const setDefaultWorkingMessage = vi.fn();
		const fakeThis: ToolTimingContext = {
			defaultWorkingMessage: "Thinking...",
			executingToolNames: new Map([["tool-1", "slow_tool"]]),
			executingToolStartedAt: new Map([["tool-1", 1_000]]),
			pendingTools: new Map([["tool-1", {}]]),
			setDefaultWorkingMessage,
			getThinkingWorkingMessage: () => "Thinking...",
			getToolWaitingMessage,
			isViewingAgentSession: () => true,
		};

		setWorkingMessageForActiveTools.call(fakeThis);

		expect(setDefaultWorkingMessage).toHaveBeenCalledWith("Waiting for tool: slow_tool... Elapsed: 3s");
	});

	test("leaves elapsed time to the live tool component", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const setDefaultWorkingMessage = vi.fn();
		const fakeThis: ToolTimingContext = {
			defaultWorkingMessage: "Thinking...",
			executingToolNames: new Map([["tool-1", "slow_tool"]]),
			executingToolStartedAt: new Map([["tool-1", 1_000]]),
			pendingTools: new Map([["tool-1", {}]]),
			setDefaultWorkingMessage,
			getThinkingWorkingMessage: () => "Thinking...",
			getToolWaitingMessage,
			isViewingAgentSession: () => false,
		};

		setWorkingMessageForActiveTools.call(fakeThis);

		expect(setDefaultWorkingMessage).toHaveBeenCalledWith("Waiting for tool: slow_tool...");
	});
});
