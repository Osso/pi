import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type ToolTimingContext = {
	defaultWorkingMessage: string;
	executingToolNames: Map<string, string>;
	executingToolStartedAt: Map<string, number>;
	pendingTools: Map<string, { hasElapsedTiming(): boolean }>;
	setDefaultWorkingMessage(message: string): void;
	getThinkingWorkingMessage(): string;
	getToolWaitingMessage(toolName: string, startedAt?: number, showElapsed?: boolean): string;
	toolComponentOwnsElapsed(toolCallId: string): boolean;
	isViewingAgentSession(): boolean;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	getToolWaitingMessage(this: ToolTimingContext, toolName: string, startedAt?: number, showElapsed?: boolean): string;
	setWorkingMessageForActiveTools(this: ToolTimingContext): void;
	toolComponentOwnsElapsed(this: ToolTimingContext, toolCallId: string): boolean;
};
const getToolWaitingMessage = interactiveModePrototype.getToolWaitingMessage;
const setWorkingMessageForActiveTools = interactiveModePrototype.setWorkingMessageForActiveTools;
const toolComponentOwnsElapsed = interactiveModePrototype.toolComponentOwnsElapsed;

function createContext(options: {
	viewingAgent: boolean;
	componentOwnsElapsed: boolean;
	toolName?: string;
}): ToolTimingContext {
	return {
		defaultWorkingMessage: "Thinking...",
		executingToolNames: new Map([["tool-1", options.toolName ?? "slow_tool"]]),
		executingToolStartedAt: new Map([["tool-1", 1_000]]),
		pendingTools: new Map([["tool-1", { hasElapsedTiming: () => options.componentOwnsElapsed }]]),
		setDefaultWorkingMessage: vi.fn(),
		getThinkingWorkingMessage: () => "Thinking...",
		getToolWaitingMessage,
		toolComponentOwnsElapsed,
		isViewingAgentSession: () => options.viewingAgent,
	};
}

describe("InteractiveMode tool waiting timing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("shows elapsed time for a reconstructed pending child-view tool", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const fakeThis = createContext({ viewingAgent: true, componentOwnsElapsed: false });

		setWorkingMessageForActiveTools.call(fakeThis);

		expect(fakeThis.setDefaultWorkingMessage).toHaveBeenCalledWith("Waiting for tool: slow_tool... Elapsed: 3s");
	});

	test("leaves elapsed time to a hydrated reconstructed child-view component", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const fakeThis = createContext({ viewingAgent: true, componentOwnsElapsed: true });

		setWorkingMessageForActiveTools.call(fakeThis);

		expect(fakeThis.setDefaultWorkingMessage).toHaveBeenCalledWith("Waiting for tool: slow_tool...");
	});

	test("shows footer elapsed when a live pending component has no timing", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const fakeThis = createContext({ viewingAgent: false, componentOwnsElapsed: false, toolName: "pyrun_eval" });

		setWorkingMessageForActiveTools.call(fakeThis);

		expect(fakeThis.setDefaultWorkingMessage).toHaveBeenCalledWith("Waiting for tool: pyrun_eval... Elapsed: 3s");
	});

	test("leaves elapsed time to the hydrated live tool component", () => {
		vi.useFakeTimers();
		vi.setSystemTime(4_000);
		const fakeThis = createContext({ viewingAgent: false, componentOwnsElapsed: true });

		setWorkingMessageForActiveTools.call(fakeThis);

		expect(fakeThis.setDefaultWorkingMessage).toHaveBeenCalledWith("Waiting for tool: slow_tool...");
	});
});
