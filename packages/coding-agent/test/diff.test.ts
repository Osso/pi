import chalk from "chalk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("renderDiff", () => {
	const originalChalkLevel = chalk.level;
	beforeAll(() => {
		initTheme("dark");
		chalk.level = 1;
	});
	afterAll(() => {
		chalk.level = originalChalkLevel;
	});

	it.each([
		{
			name: "text is inserted at the start of a line",
			diff: "-83   await commitRecordingChunk({\n+83   const result = await commitRecordingChunk({",
			expected: ["-83   await commitRecordingChunk({", "+83   const result = await commitRecordingChunk({"],
		},
		{
			name: "only the spacing between words changes",
			diff: "-1 a  b\n+1 a b",
			expected: ["-1 a  b", "+1 a b"],
		},
		{
			name: "indented text is replaced",
			diff: "-12     const value = oldValue\n+12     const value = newValue",
			expected: ["-12     const value = oldValue", "+12     const value = newValue"],
		},
	])("preserves indentation when $name", ({ diff, expected }) => {
		const rendered = renderDiff(diff);

		expect(stripAnsi(rendered).split("\n")).toEqual(expected);
	});

	it("does not highlight shared indentation as an insertion", () => {
		const rendered = renderDiff(
			"-83   await commitRecordingChunk({\n+83   const result = await commitRecordingChunk({",
		);
		const inverseInsertion = theme.inverse("const result = ");

		expect(rendered.indexOf("+83   ")).toBeLessThan(rendered.indexOf(inverseInsertion));
		expect(rendered).toContain(inverseInsertion);
	});

	it("highlights a spacing change between words", () => {
		const [removed, added] = renderDiff("-1 a  b\n+1 a b").split("\n");

		expect(removed).toContain(theme.inverse("  "));
		expect(added).toContain(theme.inverse(" "));
	});

	it("highlights a tab replaced by spaces", () => {
		const [removed, added] = renderDiff("-1 a\tb\n+1 a   b").split("\n");

		expect(stripAnsi(removed ?? "")).toBe("-1 a   b");
		expect(removed).toContain(theme.inverse("   "));
		expect(added).toContain(theme.inverse("   "));
	});
});
