import { describe, expect, it } from "vitest";
import { formatFileOperations, stripFileOperations } from "../src/core/compaction/utils.ts";

describe("stripFileOperations", () => {
	it("removes only the trailing file lists when the summary body quotes the same tags", () => {
		const body = [
			"## Goal",
			"Document the summary footer.",
			"",
			"<read-files>",
			"example.txt",
			"</read-files>",
			"",
			"## Next Steps",
			"The deadline is Friday.",
		].join("\n");
		const summary = body + formatFileOperations(["actual.txt"], ["changed.ts"]);

		expect(stripFileOperations(summary)).toBe(body);
		expect(stripFileOperations(body + formatFileOperations(["actual.txt"], []))).toBe(body);
		expect(stripFileOperations(body + formatFileOperations([], ["changed.ts"]))).toBe(body);
	});

	it("keeps a summary without a trailing file list unchanged", () => {
		const summary = "## Goal\nKeep <read-files> inline mentions.";
		expect(stripFileOperations(summary)).toBe(summary);
	});
});
