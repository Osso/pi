import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor, wordWrapLine } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

test("overwide graphemes overflow alone and preserve chunk offsets", () => {
	for (const [line, expected] of [
		["🚀", ["🚀"]],
		["a🚀b", ["a", "🚀", "b"]],
		["🚀🚀", ["🚀", "🚀"]],
		["界a", ["界", "a"]],
		["👩‍🚀x", ["👩‍🚀", "x"]],
	] as const) {
		const chunks = wordWrapLine(line, 1);
		assert.deepEqual(
			chunks.map((chunk) => chunk.text),
			expected,
		);
		let offset = 0;
		for (const chunk of chunks) {
			assert.equal(chunk.startIndex, offset);
			offset += chunk.text.length;
			assert.equal(chunk.endIndex, offset);
			assert.equal(line.slice(chunk.startIndex, chunk.endIndex), chunk.text);
		}
		assert.equal(offset, line.length);
	}
});

test("merged visual segments still split into graphemes at width one", () => {
	const line = "a🚀b";
	const segments = [{ segment: line, index: 0, input: line }];
	assert.deepEqual(wordWrapLine(line, 1, segments), wordWrapLine(line, 1));
});

test("narrow rendering and visual navigation agree on overwide chunks", () => {
	const editor = new Editor(new TUI(new VirtualTerminal(2, 24)), defaultEditorTheme);
	editor.setText("a🚀b");
	const content = () =>
		editor
			.render(2)
			.slice(1, -1)
			.map((line) => stripVTControlCharacters(line));
	assert.deepEqual(content(), ["a ", "🚀", "b "]);
	assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
	editor.handleInput("\x1b[A");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
	assert.deepEqual(content(), ["a ", "🚀", "b "]);
	editor.handleInput("\x1b[A");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
	editor.handleInput("\x1b[B");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
	editor.handleInput("\x1b[B");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
});
