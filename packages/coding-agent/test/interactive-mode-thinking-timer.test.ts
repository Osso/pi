import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface ThinkingTimerInternals {
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
