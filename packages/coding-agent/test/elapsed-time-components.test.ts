import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { formatElapsedDuration } from "../src/modes/interactive/components/elapsed-time.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import type { TUI } from "@earendil-works/pi-tui";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(requestRender: () => void = () => {}): TUI {
	return {
		requestRender,
		addInterval: (_callback: () => void, _intervalMs: number) => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestComponentRender: () => false,
	} as unknown as TUI;
}

describe("elapsed-time component rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("formats elapsed durations compactly", () => {
		expect(formatElapsedDuration(0)).toBe("0ms");
		expect(formatElapsedDuration(999)).toBe("999ms");
		expect(formatElapsedDuration(1_000)).toBe("1s");
		expect(formatElapsedDuration(65_000)).toBe("1m 05s");
		expect(formatElapsedDuration(3_660_000)).toBe("1h 01m");
	});

	test("does not globally redraw an active tool card as elapsed time advances", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-timer",
			{},
			{},
			createBaseToolDefinition(),
			createFakeTui(requestRender),
			process.cwd(),
		);

		component.markExecutionStarted(0);
		const rendersAfterStart = requestRender.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2_100);

		expect(requestRender).toHaveBeenCalledTimes(rendersAfterStart);
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("Elapsed:");

		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false, 3_250);
		vi.setSystemTime(10_000);
		component.invalidate();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Elapsed: 3s");
	});

	test("shows live elapsed time for restored pending child tools and freezes it on completion", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-restored-child",
			{},
			{},
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);

		component.markExecutionStarted(0, { showLiveElapsed: true });
		vi.setSystemTime(1_250);
		component.invalidate();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Elapsed: 1s");

		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false, 3_250);
		vi.setSystemTime(10_000);
		component.invalidate();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Elapsed: 3s");
	});

	test("shows live and final elapsed time for interactive bash executions", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const component = new BashExecutionComponent("sleep 10", createFakeTui());

		vi.setSystemTime(999);
		component.invalidate();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Running...");
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("Running 0s");

		vi.setSystemTime(1_200);
		component.invalidate();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Running 1s...");

		vi.setSystemTime(2_300);
		component.setComplete(0, false);
		vi.setSystemTime(9_000);
		component.invalidate();
		expect(stripAnsi(component.render(120).join("\n"))).toContain("elapsed 2s");
	});

	test("keeps the bash status label static when elapsed time is hidden", async () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = new BashExecutionComponent("echo done", createFakeTui(requestRender), false, {
			showElapsed: false,
		});
		try {
			const initialRenderCount = requestRender.mock.calls.length;

			await vi.advanceTimersByTimeAsync(1_000);

			expect(requestRender).toHaveBeenCalledTimes(initialRenderCount);
		} finally {
			component.dispose();
		}
	});

	test("can suppress elapsed time for restored bash executions", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const component = new BashExecutionComponent("echo restored", createFakeTui(), false, { showElapsed: false });

		vi.setSystemTime(5_000);
		component.setComplete(0, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).not.toContain("elapsed");
		expect(rendered).not.toContain("Running 5s");
	});
});
