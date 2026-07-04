import { describe, expect, test } from "vitest";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("CompactionSummaryMessageComponent", () => {
	test("shows compaction duration when present", () => {
		initTheme("dark");

		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "summary",
			tokensBefore: 1234,
			durationMs: 4567,
			timestamp: Date.now(),
		});

		expect(stripAnsi(component.render(120).join("\n"))).toContain("Compacted from 1,234 tokens in 4.6s");
	});

	test("shows tokens after compaction, tokens saved, and compacted result size", () => {
		initTheme("dark");

		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "summary",
			tokensBefore: 286705,
			tokensAfter: 31234,
			compactedResultTokens: 4567,
			timestamp: Date.now(),
		});

		const rendered = stripAnsi(component.render(140).join("\n"));

		expect(rendered).toContain("Compacted from 286,705 to 31,234 tokens");
		expect(rendered).toContain("saved 255,471");
		expect(rendered).toContain("remote result 4,567 tokens");
	});
});
