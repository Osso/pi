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
});
