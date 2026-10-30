import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ui = {
	requestRender: () => {},
	addInterval: () => ({ dispose: () => {} }),
	removeInterval: () => {},
	requestComponentRender: () => false,
} as unknown as TUI;

const malformedName = "PE-name-\u0080\u0083\u0089\u008b\u0090\u0094\u009f\u0001\u007f-end \x1b[31mred\x1b[0m";

function expectSafeLines(lines: string[], width: number): void {
	const plain = lines.map(stripAnsi).join("\n");
	expect(plain).toContain("PE-name--end red");
	expect(plain).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
}

describe("untrusted tool display controls", () => {
	beforeAll(() => initTheme("dark"));

	test("renders restored Bash output without binary controls", () => {
		const component = new BashExecutionComponent("inspect", ui, false, { showElapsed: false });
		component.appendOutput(malformedName);
		component.setComplete(0, false);
		for (const width of [40, 80]) expectSafeLines(component.render(width), width);
		component.dispose();
	});

	test("renders generic tool text without binary controls", () => {
		const component = new ToolExecutionComponent("custom_tool", "id", {}, {}, undefined, ui, process.cwd());
		component.updateResult({ content: [{ type: "text", text: malformedName }], details: {}, isError: false }, false);
		for (const width of [40, 80]) expectSafeLines(component.render(width), width);
	});
});
