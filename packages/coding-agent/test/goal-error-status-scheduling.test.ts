import { afterEach, describe, expect, it, vi } from "vitest";
import { createErrorStatusScheduler } from "../extensions/goal/src/error-status-scheduling.ts";
import type { ExtensionContext } from "../src/core/extensions/index.ts";

describe("goal error status scheduling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not append deferred error status while an idle session is retrying", () => {
		vi.useFakeTimers();
		let activeRetry = true;
		const statuses: string[] = [];
		const context = {
			sessionManager: { getSessionId: () => "session-1" },
			hasPendingMessages: () => false,
			isIdle: () => true,
			hasActiveRetry: () => activeRetry,
		} as unknown as ExtensionContext;
		const scheduler = createErrorStatusScheduler({
			onStatus: (_ctx, message) => statuses.push(message),
		});

		scheduler.schedule(context, "Goal continuation skipped: the model turn ended with an error.");
		vi.advanceTimersByTime(10);

		expect(statuses).toEqual([]);

		activeRetry = false;
		vi.advanceTimersByTime(10);

		expect(statuses).toEqual(["Goal continuation skipped: the model turn ended with an error."]);
	});
});
