import assert from "node:assert";
import { describe, it } from "node:test";
import { highlightHistorySearchMatch } from "../src/components/editor-history-search.ts";

describe("highlightHistorySearchMatch", () => {
	it("highlights the match when lowercasing an earlier character changes its length", () => {
		assert.strictEqual(
			highlightHistorySearchMatch("İstanbul error log", "error"),
			"İstanbul \x1b[7merror\x1b[27m log",
		);
	});
});
