import assert from "node:assert";
import { describe, it } from "node:test";
import { viewportTopAfterOffscreenChange } from "../src/scrollback.ts";

describe("viewportTopAfterOffscreenChange", () => {
	const previous = ["old heading", "a", "b", "c", "d", "e"];

	it("follows rows inserted above when a visible row also changed", () => {
		const next = ["new heading", "x", "y", "a", "b", "c", "d", "e edited"];
		assert.strictEqual(viewportTopAfterOffscreenChange(previous, next, 1), 3);
	});

	it("follows rows inserted above when rows were also appended", () => {
		const next = ["new heading", "x", "a", "b", "c", "d", "e", "f", "g"];
		assert.strictEqual(viewportTopAfterOffscreenChange(previous, next, 1), 2);
	});

	it("keeps the old top when most visible rows changed", () => {
		const next = ["new heading", "x", "p", "q", "r", "s", "e"];
		assert.strictEqual(viewportTopAfterOffscreenChange(previous, next, 1), 1);
	});

	it("does not anchor on repeated blank rows", () => {
		const blankViewport = ["heading", "", "", "", "text"];
		const next = ["heading 2", "", "", "", "other", "", "", "", "more"];
		assert.strictEqual(viewportTopAfterOffscreenChange(blankViewport, next, 1), 1);
	});
});
