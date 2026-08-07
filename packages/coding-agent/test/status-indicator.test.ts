import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	IdleStatus,
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("keeps configured working status frames static", async () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestComponentRender = vi.fn(() => false);
		const tui = { requestComponentRender } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Working...", {
			frames: ["a", "b"],
			intervalMs: 250,
		});
		try {
			const callsAfterConstruction = requestComponentRender.mock.calls.length;

			await vi.advanceTimersByTimeAsync(1000);

			expect(requestComponentRender).toHaveBeenCalledTimes(callsAfterConstruction);
		} finally {
			indicator.dispose();
		}
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestComponentRender = vi.fn(() => false);
		const tui = { requestComponentRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestComponentRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestComponentRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});
});
