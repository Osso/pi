import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, expect, test } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const tui = {
	requestRender: () => {},
	addInterval: () => ({ dispose: () => {} }),
	removeInterval: () => {},
	requestComponentRender: () => false,
} as unknown as TUI;

beforeAll(() => initTheme("dark"));

test.each([false, true])("a rebuilt bash card shows only its recorded duration (expanded: %s)", (expanded) => {
	const finishedAt = new Date(2024, 0, 2, 3, 4, 5).getTime();
	const card = new ToolExecutionComponent(
		"bash",
		"bash-rebuilt",
		{ command: "echo done" },
		{},
		createBashToolDefinition(process.cwd()),
		tui,
		process.cwd(),
	);
	card.setExpanded(expanded);
	card.markExecutionStarted(finishedAt - 2000);
	card.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false, finishedAt);

	const lines = card
		.render(80)
		.map(stripAnsi)
		.map((line) => line.trim())
		.filter(Boolean);

	expect(lines).toContain("Elapsed: 2s 03:04:05");
	expect(lines.filter((line) => /^(Took|Elapsed)\b/.test(line))).toEqual(["Elapsed: 2s 03:04:05"]);
});
