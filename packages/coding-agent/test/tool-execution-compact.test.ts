import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createPyrunToolDefinition } from "../extensions/pyrun/src/index.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEndTurnToolDefinition } from "../src/core/tools/end-turn.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: "test tool",
		parameters: Type.Any(),
		execute: async () => ({ content: [], details: undefined }),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
		addInterval: () => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestComponentRender: () => false,
	} as unknown as TUI;
}

describe("ToolExecutionComponent compact and hidden rows", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("hideOutput keeps a quiet running bash elapsed timer ticking and stops it on completion", () => {
		vi.useFakeTimers();
		try {
			const component = new ToolExecutionComponent(
				"bash",
				"tool-hidden-bash",
				{ command: "sleep 10" },
				{ hideOutput: true },
				createBashToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.markExecutionStarted(Date.now());
			component.updateResult({ content: [], details: undefined, isError: false }, true);

			vi.advanceTimersByTime(3000);
			const running = stripAnsi(component.render(120).join("\n"));
			expect(running).toContain("bash Elapsed: 3s");
			expect(running).not.toContain("sleep 10");
			expect(running.split("\n")).toHaveLength(2);
			expect(running.split("\n")[0]).toBe("");

			component.updateResult(
				{
					content: [{ type: "text", text: "slept" }],
					details: undefined,
					isError: false,
				},
				false,
			);
			expect(vi.getTimerCount()).toBe(0);
			const completed = stripAnsi(component.render(120).join("\n"));
			expect(completed).not.toContain("slept");
			expect(completed.split("\n")).toHaveLength(2);
			expect(completed.split("\n")[0]).toBe("");

			component.setHideOutput(false);
			const visible = stripAnsi(component.render(120).join("\n"));
			expect(visible).toContain("sleep 10");
			expect(visible).toContain("slept");
		} finally {
			vi.useRealTimers();
		}
	});

	test("status tools keep one outer margin and one width-bounded timing row", () => {
		vi.useFakeTimers();
		try {
			for (const toolName of ["wait_agent", "end_turn"] as const) {
				const component = new ToolExecutionComponent(
					toolName,
					`tool-${toolName}-compact`,
					{},
					{},
					toolName === "end_turn" ? createEndTurnToolDefinition() : createBaseToolDefinition(toolName),
					createFakeTui(),
					process.cwd(),
				);
				component.markExecutionStarted(Date.now(), { showLiveElapsed: true });
				vi.advanceTimersByTime(1250);
				const running = component.render(24);
				expect(running).toHaveLength(2);
				expect(running[0]).toBe("");
				expect(visibleWidth(running[1] ?? "")).toBeLessThanOrEqual(24);
				expect(stripAnsi(running.join("\n"))).toContain(toolName);
				expect(stripAnsi(running.join("\n"))).toContain("Elapsed: 1s");

				const finishedAt = Date.now();
				component.updateResult(
					{
						content: [{ type: "text", text: "successful detail" }],
						isError: false,
					},
					false,
					finishedAt,
				);
				const completed = component.render(120);
				expect(completed).toHaveLength(2);
				expect(completed[0]).toBe("");
				expect(stripAnsi(completed.join("\n"))).toContain("Elapsed: 1s");
				expect(stripAnsi(completed.join("\n"))).toMatch(/\d{2}:\d{2}:\d{2}/);
				expect(stripAnsi(completed.join("\n"))).not.toContain("successful detail");

				component.setExpanded(true);
				expect(stripAnsi(component.render(120).join("\n"))).toContain("successful detail");
			}
		} finally {
			vi.useRealTimers();
		}
	});

	test("status rows omit live elapsed time unless enabled", () => {
		vi.useFakeTimers();
		try {
			const component = new ToolExecutionComponent(
				"end_turn",
				"tool-end-turn-no-live-timer",
				{},
				{},
				createEndTurnToolDefinition(),
				createFakeTui(),
				process.cwd(),
			);
			component.markExecutionStarted(Date.now());
			vi.advanceTimersByTime(2000);
			expect(stripAnsi(component.render(120).join("\n"))).not.toContain("Elapsed:");
			component.markExecutionStarted(Date.now(), { showLiveElapsed: true });
			vi.advanceTimersByTime(2000);
			expect(stripAnsi(component.render(120).join("\n"))).toContain("Elapsed: 2s");
		} finally {
			vi.useRealTimers();
		}
	});

	test("status errors obey hideOutput, including tools without a definition", () => {
		for (const toolName of ["wait_agent", "end_turn"] as const) {
			const component = new ToolExecutionComponent(
				toolName,
				`tool-${toolName}-error-hidden`,
				{},
				{ hideOutput: true },
				undefined,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{
					content: [{ type: "text", text: "private status error" }],
					isError: true,
				},
				false,
			);

			const hidden = stripAnsi(component.render(80).join("\n"));
			expect(hidden).toContain(toolName);
			expect(hidden).not.toContain("private status error");

			component.setHideOutput(false);
			const visible = stripAnsi(component.render(80).join("\n"));
			expect(visible).toContain("private status error");
		}
	});

	test("hidden Bash and Pyrun errors do not reveal commands, code, or results", () => {
		const bashCommand = "private bash command";
		const bashResult = "private bash stderr: failure; Command exited with code 7";
		const bash = new ToolExecutionComponent(
			"bash",
			"tool-hidden-bash-error",
			{ command: bashCommand },
			{ hideOutput: true },
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		bash.updateResult({ content: [{ type: "text", text: bashResult }], isError: true }, false);

		const hiddenBash = stripAnsi(bash.render(120).join("\n"));
		expect(hiddenBash).toContain("bash");
		expect(hiddenBash).not.toContain(bashCommand);
		expect(hiddenBash).not.toContain("private bash stderr");
		expect(hiddenBash).not.toContain("code 7");

		const pyrunCode = "print('private Pyrun code')";
		const pyrunResult = "private Pyrun error output";
		const pyrun = new ToolExecutionComponent(
			"pyrun_eval",
			"tool-hidden-pyrun-error",
			{ code: pyrunCode },
			{ hideOutput: true },
			createPyrunToolDefinition(async () => ({
				content: [],
				details: undefined,
			})),
			createFakeTui(),
			process.cwd(),
		);
		pyrun.updateResult(
			{
				content: [{ type: "text", text: pyrunResult }],
				details: { executed: pyrunCode },
				isError: true,
			},
			false,
		);

		const hiddenPyrun = stripAnsi(pyrun.render(120).join("\n"));
		expect(hiddenPyrun).toContain("pyrun_eval");
		expect(hiddenPyrun).not.toContain(pyrunCode);
		expect(hiddenPyrun).not.toContain(pyrunResult);

		bash.setHideOutput(false);
		pyrun.setHideOutput(false);
		expect(stripAnsi(bash.render(120).join("\n"))).toContain(bashResult);
		expect(stripAnsi(pyrun.render(120).join("\n"))).toContain(pyrunResult);
	});

	test("compact status rows keep renderer fallback errors visible when output is enabled", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition("wait_agent"),
			renderResult: () => {
				throw new Error("renderer failed");
			},
		};
		const component = new ToolExecutionComponent(
			"wait_agent",
			"tool-wait-agent-renderer-fallback",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "fallback error detail" }],
				isError: true,
			},
			false,
		);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("wait_agent");
		expect(rendered).toContain("fallback error detail");
	});

	test("hideOutput keeps legacy definition-less Pyrun rows private", () => {
		const code = "private historical Pyrun code";
		const component = new ToolExecutionComponent(
			"pyrun_eval",
			"tool-hidden-legacy-pyrun",
			{ code },
			{ hideOutput: true },
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "private historical result" }],
				isError: true,
			},
			false,
		);

		const hidden = stripAnsi(component.render(120).join("\n"));
		expect(hidden).toContain("pyrun_eval");
		expect(hidden).not.toContain(code);
		expect(hidden).not.toContain("private historical result");

		component.setHideOutput(false);
		const visible = stripAnsi(component.render(120).join("\n"));
		expect(visible).toContain(code);
		expect(visible).toContain("private historical result");
	});

	test.each([false, true])("hidden Pyrun retains state backgrounds (error: %s)", (isError) => {
		const component = new ToolExecutionComponent(
			"pyrun_eval",
			"tool-hidden-pyrun-colors",
			{ code: "print('private code')" },
			{ hideOutput: true },
			createPyrunToolDefinition(async () => ({ content: [], details: undefined })),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted(1000);
		expect(component.render(80).join("\n")).toContain(theme.getBgAnsi("toolPendingBg"));

		component.updateResult({ content: [{ type: "text", text: "private result" }], isError }, false, 2000);
		const completedColor = isError ? "toolErrorBg" : "toolSuccessBg";
		for (const width of [20, 80]) {
			const lines = component.render(width);
			const rendered = lines.join("\n");
			expect(rendered).toContain(theme.getBgAnsi(completedColor));
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(stripAnsi(rendered)).not.toContain("private");
		}
		component.setHideOutput(false);
		const visible = component.render(80).join("\n");
		expect(visible).toContain(theme.getBgAnsi(completedColor));
		expect(stripAnsi(visible)).toContain("private code");
		expect(stripAnsi(visible)).toContain("private result");
	});

	test("hideOutput keeps Pyrun name and timing without code or result", () => {
		vi.useFakeTimers();
		try {
			const code = "print('private code')";
			const component = new ToolExecutionComponent(
				"pyrun_eval",
				"tool-hidden-pyrun",
				{ code },
				{ hideOutput: true },
				createPyrunToolDefinition(async () => ({
					content: [],
					details: undefined,
				})),
				createFakeTui(),
				process.cwd(),
			);
			component.markExecutionStarted(Date.now(), { showLiveElapsed: true });
			vi.advanceTimersByTime(1250);
			component.updateResult(
				{
					content: [{ type: "text", text: `${code}\nprivate result` }],
					details: { executed: code },
					isError: false,
				},
				false,
			);

			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).toContain("pyrun_eval");
			expect(rendered).toContain("Elapsed: 1s");
			expect(rendered).not.toContain(code);
			expect(rendered).not.toContain("private result");
			expect(rendered.split("\n").length).toBeGreaterThan(1);
			expect(component.render(120).join("\n")).toMatch(/\u001b\[48;2;\d+;\d+;\d+m/);

			component.setHideOutput(false);
			const visible = stripAnsi(component.render(120).join("\n"));
			expect(visible).toContain(code);
		} finally {
			vi.useRealTimers();
		}
	});
});
