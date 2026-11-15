import { beforeAll, describe, expect, it } from "vitest";
import { generateDiffString } from "../src/core/tools/edit-diff.ts";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("renderDiff with Unicode line separators", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("colors a removed line containing U+2028 as removed", () => {
		const { diff } = generateDiffString("x\u2028y\nkeep\n", "z\nkeep\n");

		const rendered = renderDiff(diff).split("\n");
		const removed = rendered.find((line) => line.includes("x\u2028y"));

		expect(removed).toBeDefined();
		expect(removed).toContain(theme.getFgAnsi("toolDiffRemoved"));
		expect(removed).not.toContain(theme.getFgAnsi("toolDiffContext"));
	});
});
