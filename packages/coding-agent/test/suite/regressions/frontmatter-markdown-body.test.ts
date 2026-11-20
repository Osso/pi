import { expect, it } from "vitest";
import { parseFrontmatter, stripFrontmatter } from "../../../src/utils/frontmatter.ts";

it("keeps opening Markdown rules and a heading when the enclosed text is not a metadata map", () => {
	const markdown = "---\nNotes\n---\nReview the notes.";
	expect(parseFrontmatter(markdown)).toEqual({ frontmatter: {}, body: markdown });
	expect(stripFrontmatter(markdown)).toBe(markdown);
});
