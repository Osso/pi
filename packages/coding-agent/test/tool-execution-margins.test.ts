import { Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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
		const ui = {
			requestRender: () => {},
			addInterval: () => ({ dispose: () => {} }),
			removeInterval: () => {},
			requestComponentRender: () => false,
		} as unknown as TUI;
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
});
