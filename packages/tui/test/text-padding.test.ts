import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

describe("Text and Markdown padding", () => {
	it("keeps every line within the render width when padding fills the viewport", () => {
		for (const width of [1, 2, 3, 4, 5]) {
			for (const line of new Text("hello", 2, 1).render(width)) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
			}
		}
		assert.deepStrictEqual(new Text("hello", 2, 0).render(9), ["  hello  "]);
	});

	it("keeps wide characters within the render width when padding leaves one column", () => {
		for (const text of ["界", "a界b", "🙂", "👨‍👩‍👧‍👦"]) {
			for (const width of [1, 2, 3, 4]) {
				for (const line of new Text(text, 1, 0).render(width)) {
					assert.ok(visibleWidth(line) <= width, `${text} at width ${width}: ${JSON.stringify(line)}`);
				}
			}
		}
		assert.deepStrictEqual(new Text("a界b", 1, 0).render(4), [" a  ", " 界 ", " b  "]);
	});

	it("keeps Markdown lines within the render width when padding fills the viewport", () => {
		for (const width of [1, 2, 3, 4, 5]) {
			for (const line of new Markdown("hello", 2, 1, defaultMarkdownTheme).render(width)) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
			}
		}
		assert.deepStrictEqual(new Markdown("hello", 2, 0, defaultMarkdownTheme).render(9), ["  hello  "]);
	});
});
