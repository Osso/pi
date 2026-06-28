import assert from "node:assert/strict";
import { test } from "node:test";
import { DynamicBorder } from "../src/index.ts";

test("DynamicBorder renders a full-width border", () => {
	const border = new DynamicBorder();

	assert.deepEqual(border.render(4), ["────"]);
});

test("DynamicBorder applies a custom formatter", () => {
	const border = new DynamicBorder((line) => `[${line}]`);

	assert.deepEqual(border.render(3), ["[───]"]);
});

test("DynamicBorder renders at least one cell", () => {
	const border = new DynamicBorder();

	assert.deepEqual(border.render(0), ["─"]);
});
