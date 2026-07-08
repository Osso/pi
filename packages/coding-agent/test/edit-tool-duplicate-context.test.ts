import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent } from "../src/core/tools/edit-diff.ts";

describe("edit tool duplicate match errors", () => {
	it("includes line numbers and context for duplicate single-edit matches", () => {
		try {
			applyEditsToNormalizedContent(
				["function first() {", "\treturn value;", "}", "", "function second() {", "\treturn value;", "}"].join(
					"\n",
				),
				[{ oldText: "\treturn value;", newText: "\treturn changed;" }],
				"sample.ts",
			);
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toContain("Found 2 occurrences of the text in sample.ts. The text must be unique.");
			expect(message).toContain("Duplicate match context:");
			expect(message).toContain("1) line 2\n  1: function first() {\n> 2: \treturn value;");
			expect(message).toContain("2) line 6\n  4: \n  5: function second() {\n> 6: \treturn value;");
			return;
		}
		throw new Error("Expected duplicate match error");
	});

	it("includes the edit index for duplicate matches in multi-edit calls", () => {
		expect(() =>
			applyEditsToNormalizedContent(
				"alpha\ntarget\nbeta\ntarget\ngamma\n",
				[
					{ oldText: "alpha", newText: "ALPHA" },
					{ oldText: "target", newText: "TARGET" },
				],
				"sample.txt",
			),
		).toThrowError(/Found 2 occurrences of edits\[1\] in sample\.txt\.[\s\S]*1\) line 2[\s\S]*2\) line 4/);
	});
});
