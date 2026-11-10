import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createEndTurnToolDefinition } from "../src/core/tools/end-turn.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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
		addInterval: (_callback: () => void, _intervalMs: number) => ({
			dispose: () => {},
		}),
		removeInterval: () => {},
		requestComponentRender: () => false,
	} as unknown as TUI;
}

describe("ToolExecutionComponent completion clock", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test.each([false, true])("normal card keeps only its outer margin (definition: %s)", (hasDefinition) => {
		const finishedAt = new Date(2024, 0, 2, 3, 4, 5).getTime();
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-card-padding",
			undefined,
			{ hideOutput: true },
			hasDefinition ? createBaseToolDefinition() : undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted(finishedAt - 2000);
		component.updateResult({ content: [{ type: "text", text: "hidden result" }], isError: false }, false, finishedAt);

		const lines = component.render(80).map(stripAnsi);
		expect(lines.map((line) => line.trim())).toEqual(["", "custom_tool", "Elapsed: 2s 03:04:05"]);
		expect(lines.slice(1).every((line) => line.startsWith(" "))).toBe(true);
	});

	test("shows muted local completion time beside the existing elapsed duration and keeps it stable", () => {
		vi.useFakeTimers();
		try {
			const finishedAt = new Date(2024, 0, 2, 3, 4, 5).getTime();
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-clock",
				{},
				{},
				createBaseToolDefinition(),
				createFakeTui(),
				process.cwd(),
			);
			component.markExecutionStarted(finishedAt - 2000);
			component.updateResult({ content: [], isError: false }, false, finishedAt);

			const rendered = component.render(120).join("\n");
			const plainLines = stripAnsi(rendered).split("\n");
			expect(plainLines.some((line) => line.includes("Elapsed: 2s") && line.includes("03:04:05"))).toBe(true);
			expect(rendered).toContain(theme.fg("muted", "Elapsed: 2s 03:04:05"));

			vi.advanceTimersByTime(60_000);
			component.invalidate();
			expect(component.render(120).join("\n")).toBe(rendered);
		} finally {
			vi.useRealTimers();
		}
	});

	test("shows a muted completion clock on generic tool rows without a start timestamp", () => {
		const component = new ToolExecutionComponent(
			"unknown_tool",
			"tool-generic-clock",
			{},
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], isError: false }, false, new Date(2024, 0, 2, 3, 4, 5).getTime());
		expect(component.render(120).join("\n")).toContain(theme.fg("muted", "03:04:05"));
	});

	test("shows the completion clock for end_turn", () => {
		const component = new ToolExecutionComponent(
			"end_turn",
			"tool-end-turn-clock",
			{ reason: "done" },
			{},
			createEndTurnToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted(new Date(2024, 0, 2, 3, 4, 4).getTime());
		component.updateResult(
			{ content: [{ type: "text", text: "Turn ended: done" }], isError: false },
			false,
			new Date(2024, 0, 2, 3, 4, 5).getTime(),
		);
		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain("end_turn");
		expect(rendered).toContain(theme.fg("muted", "03:04:05"));
	});
});
