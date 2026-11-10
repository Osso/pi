import { Container, type TUI } from "@earendil-works/pi-tui";
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
