import assert from "node:assert";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { Text } from "../src/components/text.ts";
import { visibleWidth } from "../src/utils.ts";

describe("Box at narrow widths", () => {
	it("shrinks its padding so no line is wider than the terminal", () => {
		const box = new Box(1, 1, (text) => `\x1b[44m${text}\x1b[49m`);
		box.addChild(new Text("hello world", 0, 0));

		for (const width of [1, 2, 3]) {
			const widths = box.render(width).map((line) => visibleWidth(line));
			assert.ok(
				widths.every((lineWidth) => lineWidth <= width),
				`width ${width}: ${widths.join(",")}`,
			);
		}
		assert.deepStrictEqual(
			box
				.render(1)
				.slice(1, -1)
				.map((line) => line.replace(/\x1b\[\d+m/g, "")),
			["h", "e", "l", "l", "o", "w", "o", "r", "l", "d"],
		);
	});
});
