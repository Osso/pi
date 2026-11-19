import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface ThinkingTimerInternals {
	handleEvent(this: unknown, event: unknown): Promise<void>;
	handleHiddenMainSessionDisplayEvent(this: unknown, event: unknown): boolean;
	syncToolExecutionTrackingForHiddenMainEvent(this: unknown, event: unknown): void;
	getThinkingWorkingMessage(this: unknown): string;
	setDefaultWorkingMessage(this: unknown, message: string): void;
	startThinkingTimer(this: unknown): void;
	stopThinkingTimer(this: unknown): void;
	updateThinkingWorkingMessage(this: unknown): void;
}

const thinkingTimer = InteractiveMode.prototype as unknown as ThinkingTimerInternals;

type ThinkingTimerFixture = {
	defaultWorkingMessage: string;
	executingToolNames: Map<string, string>;
	getThinkingWorkingMessage: ThinkingTimerInternals["getThinkingWorkingMessage"];
	setDefaultWorkingMessage: ReturnType<typeof vi.fn>;
	startThinkingTimer: ThinkingTimerInternals["startThinkingTimer"];
	stopThinkingTimer: ThinkingTimerInternals["stopThinkingTimer"];
	thinkingStartedAt: number | undefined;
	thinkingTimer: ReturnType<typeof setInterval> | undefined;
	updateThinkingWorkingMessage: ThinkingTimerInternals["updateThinkingWorkingMessage"];
};

function createFixture(): ThinkingTimerFixture {
	return {
		defaultWorkingMessage: "Thinking...",
		executingToolNames: new Map(),
		getThinkingWorkingMessage: thinkingTimer.getThinkingWorkingMessage,
		setDefaultWorkingMessage: vi.fn(),
		startThinkingTimer: thinkingTimer.startThinkingTimer,
		stopThinkingTimer: thinkingTimer.stopThinkingTimer,
		thinkingStartedAt: undefined,
		thinkingTimer: undefined,
		updateThinkingWorkingMessage: thinkingTimer.updateThinkingWorkingMessage,
	};
}

describe("InteractiveMode thinking timer", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("shows elapsed time in the Thinking ticker and stops updating when finished", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const fixture = createFixture();

		thinkingTimer.startThinkingTimer.call(fixture);
		expect(fixture.setDefaultWorkingMessage).toHaveBeenLastCalledWith("Thinking... 0s");

		vi.advanceTimersByTime(65_000);
		expect(fixture.setDefaultWorkingMessage).toHaveBeenLastCalledWith("Thinking... 1m 05s");

		thinkingTimer.stopThinkingTimer.call(fixture);
		vi.advanceTimersByTime(1_000);
		expect(fixture.setDefaultWorkingMessage).toHaveBeenCalledTimes(66);
	});

	test("updates elapsed Thinking text on the main loader even when an agent remains selected", () => {
		const setMessage = vi.fn();
		const fixture = {
			currentWorkingDefaultMessage: "Thinking...",
			defaultWorkingMessage: "Thinking...",
			isViewingAgentSession: () => true,
			loadingAnimation: { setMessage },
			workingLoaderView: "main",
			workingMessage: undefined,
		};

		thinkingTimer.setDefaultWorkingMessage.call(fixture, "Thinking... 1s");

		expect(setMessage).toHaveBeenCalledWith("Thinking... 1s");
	});

	test("times a main-session model request that starts while a child view is selected", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const fixture = {
			...createFixture(),
			handleHiddenMainSessionDisplayEvent: thinkingTimer.handleHiddenMainSessionDisplayEvent,
			isInitialized: true,
			isViewingAgentSession: () => true,
			syncToolExecutionTrackingForHiddenMainEvent: thinkingTimer.syncToolExecutionTrackingForHiddenMainEvent,
			ui: { requestRender: vi.fn() },
		};

		await thinkingTimer.handleEvent.call(fixture, { type: "model_request_start" });
		vi.advanceTimersByTime(2_000);
		expect(fixture.setDefaultWorkingMessage).toHaveBeenLastCalledWith("Thinking... 2s");

		await thinkingTimer.handleEvent.call(fixture, { type: "model_request_end" });
		vi.advanceTimersByTime(2_000);
		expect(fixture.setDefaultWorkingMessage).toHaveBeenLastCalledWith("Thinking... 2s");
		expect(fixture.thinkingTimer).toBeUndefined();
	});

	test("leaves tool waiting messages in control of the tool timer", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const fixture = createFixture();
		fixture.executingToolNames.set("call-1", "read");

		thinkingTimer.startThinkingTimer.call(fixture);
		vi.advanceTimersByTime(2_000);

		expect(fixture.setDefaultWorkingMessage).not.toHaveBeenCalled();
		thinkingTimer.stopThinkingTimer.call(fixture);
	});
});
