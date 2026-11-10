import { Container, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { generateDiffString } from "../src/core/tools/edit-diff.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
		addInterval: () => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestComponentRender: () => false,
	} as unknown as TUI;
}

describe("Tool transcript margins", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test.each([
		["custom_tool", "end_turn"],
		["custom_tool", "wait_agent"],
		["wait_agent", "end_turn"],
		["end_turn", "custom_tool"],
		["custom_tool", "custom_tool"],
	])("keeps exactly one gap between %s and %s", (first, second) => {
		const ui = createFakeTui();
		const transcript = new Container();
		for (const name of [first, second]) {
			transcript.addChild(
				new ToolExecutionComponent(
					name,
					`call-${name}`,
					undefined,
					{ hideOutput: true },
					undefined,
					ui,
					process.cwd(),
				),
			);
		}

		expect(transcript.render(80).map((line) => stripAnsi(line).trim())).toEqual(["", first, "", second]);
	});

	test.each(["wait_agent", "end_turn", "bash"])("aligns compact %s with normal tool cards", (name) => {
		const normal = new ToolExecutionComponent(
			"custom_tool",
			"normal",
			undefined,
			{ hideOutput: true },
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const compact = new ToolExecutionComponent(
			name,
			"compact",
			undefined,
			{ hideOutput: true },
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const normalHeader = normal
			.render(80)
			.map(stripAnsi)
			.find((line) => line.includes("custom_tool"));
		expect(normalHeader?.search(/\S/)).toBe(1);
		expect(stripAnsi(compact.render(80)[1] ?? "").indexOf(name)).toBe(normalHeader?.search(/\S/));
		for (const width of [0, 1, 2, 12, 80]) {
			const lines = compact.render(width);
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	test("aligns visible compact error details with their heading", () => {
		const component = new ToolExecutionComponent(
			"wait_agent",
			"error-indent",
			undefined,
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "Visible wait failure" }], isError: true }, false, 2000);
		const lines = component.render(48).map(stripAnsi);
		expect(lines[1]?.indexOf("wait_agent")).toBe(1);
		expect(lines[2]?.indexOf("Visible wait failure")).toBe(1);
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
	});

	test.each([false, true])("edit preview has no inner edge padding (hide output: %s)", (hideOutput) => {
		const component = new ToolExecutionComponent(
			"edit",
			"edit-padding",
			{ path: "/tmp/edit-padding.txt", edits: [{ oldText: "old line", newText: "new line" }] },
			{ hideOutput },
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const pending = component.render(100).map(stripAnsi);
		expect(pending).toHaveLength(2);
		expect(pending[0]).toBe("");
		expect(pending[1]?.trim()).toContain("edit /tmp/edit-padding.txt");

		component.markExecutionStarted(1000);
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block." }],
				details: generateDiffString("old line\n", "new line\n"),
				isError: false,
			},
			false,
			2000,
		);
		const settled = component.render(100).map(stripAnsi);
		expect(settled[0]).toBe("");
		expect(settled[1]?.trim()).toContain("edit /tmp/edit-padding.txt");
		expect(settled.join("\n")).toContain("old line");
		expect(settled.at(-2)).toContain("new line");
		expect(settled.at(-1)).toContain("Elapsed: 1s");
	});
});
