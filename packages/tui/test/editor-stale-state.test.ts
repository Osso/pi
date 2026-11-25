import assert from "node:assert";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { TUI } from "../src/tui.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	return new Editor(new TUI(new VirtualTerminal(80, 24)), defaultEditorTheme);
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

/** Offers `repo` for arguments of `/cmd` and `/cmd` itself inside the command name. */
const commandArgumentProvider: AutocompleteProvider = {
	getSuggestions: async (lines, _cursorLine, cursorCol) => {
		const before = (lines[0] || "").slice(0, cursorCol);
		if (!before.startsWith("/")) return null;
		if (before.includes(" ")) {
			return { items: [{ value: "repo", label: "repo" }], prefix: before.slice(before.indexOf(" ") + 1) };
		}
		return { items: [{ value: "/cmd", label: "cmd" }], prefix: before };
	},
	applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
		const line = lines[cursorLine] || "";
		const newLines = [...lines];
		newLines[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
		return { lines: newLines, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
	},
};

async function typeWithAutocomplete(editor: Editor, text: string): Promise<void> {
	for (const ch of text) {
		editor.handleInput(ch);
		await flushAutocomplete();
	}
}

describe("Editor state after non-typing edits", () => {
	it("refreshes the autocomplete picker after Ctrl+W so Tab does not apply a stale suggestion", async () => {
		const editor = createEditor();
		editor.setAutocompleteProvider(commandArgumentProvider);
		await typeWithAutocomplete(editor, "/cmd re");
		assert.strictEqual(editor.isShowingAutocomplete(), true);

		editor.handleInput("\x17"); // Ctrl+W deletes "re"
		await flushAutocomplete();
		editor.handleInput("\t");

		assert.strictEqual(editor.getText(), "/cmd repo");
	});

	it("refreshes the autocomplete picker after undo so Tab does not apply a stale suggestion", async () => {
		const editor = createEditor();
		editor.setAutocompleteProvider(commandArgumentProvider);
		await typeWithAutocomplete(editor, "/cmd re");
		assert.strictEqual(editor.isShowingAutocomplete(), true);

		editor.handleInput("\x1b[45;5u"); // Ctrl+- undoes " re"
		await flushAutocomplete();
		assert.strictEqual(editor.getText(), "/cmd");
		editor.handleInput("\t");

		assert.strictEqual(editor.getText(), "/cmd");
	});

	it("does not jump into a paste marker, so the pasted content survives submit", () => {
		const editor = createEditor();
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		const pasted = "line\n".repeat(20).trimEnd();
		editor.handleInput("A");
		editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
		editor.handleInput(" #");

		editor.handleInput("\x01"); // Ctrl+A
		editor.handleInput("\x1d"); // Ctrl+]
		editor.handleInput("#");
		editor.handleInput("x");
		editor.handleInput("\r");

		assert.deepStrictEqual(submitted, [`A${pasted} x#`]);
	});

	it("submits marker-like text inside an earlier paste literally", () => {
		const editor = createEditor();
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		const first = `${"x\n".repeat(11)}literal [paste #2 +11 lines] end`;
		const second = "y\n".repeat(11).trimEnd();
		editor.handleInput(`\x1b[200~${first}\x1b[201~`);
		editor.handleInput(`\x1b[200~${second}\x1b[201~`);
		editor.handleInput("\r");

		assert.deepStrictEqual(submitted, [first + second]);
	});

	it("keeps a short paste that mentions an earlier paste's id literal", () => {
		const editor = createEditor();
		const submitted: string[] = [];
		editor.onSubmit = (text) => submitted.push(text);
		const large = "A".repeat(1001);
		editor.handleInput(`\x1b[200~${large}\x1b[201~`);
		editor.handleInput("\x1b[200~ literal [paste #1 +12 lines] end\x1b[201~");
		editor.handleInput("\r");

		assert.deepStrictEqual(submitted, [`${large} literal [paste #1 +12 lines] end`]);
	});

	it("keeps Ctrl+R history search active when pasting query text", () => {
		const editor = createEditor();
		editor.addToHistory("open config docs");
		editor.handleInput("\x12"); // Ctrl+R
		editor.handleInput("config");
		editor.handleInput("\x1b[200~ docs\x1b[201~");

		assert.strictEqual(editor.getText(), "config docs");

		editor.handleInput("\r"); // accept the matching history entry
		assert.strictEqual(editor.getText(), "open config docs");
	});

	it("normalizes pasted line endings before matching history entries", () => {
		const editor = createEditor();
		editor.addToHistory("open config\ndocs");
		editor.handleInput("\x12"); // Ctrl+R
		editor.handleInput("\x1b[200~config\r\ndocs\x1b[201~");

		assert.strictEqual(editor.getText(), "config\ndocs");
		editor.handleInput("\r");
		assert.strictEqual(editor.getText(), "open config\ndocs");
	});

	it("undoes an accepted Ctrl+R history search back to the draft", () => {
		const editor = createEditor();
		editor.addToHistory("abc def");
		editor.handleInput("a");
		editor.handleInput("b");
		editor.handleInput("c");

		editor.handleInput("\x12"); // Ctrl+R
		editor.handleInput("\r"); // accept "abc def"
		assert.strictEqual(editor.getText(), "abc def");

		editor.handleInput("\x1b[45;5u"); // Ctrl+- undo
		assert.strictEqual(editor.getText(), "abc");
	});

	it("undoes an accepted Ctrl+R match identical to the draft back to the draft cursor", () => {
		const editor = createEditor();
		editor.addToHistory("abc");
		for (const char of "abc") editor.handleInput(char);
		editor.handleInput("\x1b[D"); // Left: cursor at column 2

		editor.handleInput("\x12"); // Ctrl+R
		editor.handleInput("\r"); // accept "abc", cursor moves to the end
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

		editor.handleInput("\x1b[45;5u"); // Ctrl+- undo
		assert.strictEqual(editor.getText(), "abc");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
	});

	it("forgets a paste-marker snap column on undo", () => {
		const editor = createEditor();
		editor.setText("0123456789ABCDEF\nabcdefghijklmnop");
		editor.handleInput("\x01"); // Ctrl+A: start of line 1
		editor.handleInput(`\x1b[200~${"line\n".repeat(20).trimEnd()}\x1b[201~`);
		editor.handleInput("\x01"); // Ctrl+A: start of line 1, before the marker
		editor.handleInput("\x1b[A"); // Up to line 0
		for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
		editor.handleInput("\x1b[B"); // Down snaps onto the marker at (1, 0)
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

		editor.handleInput("\x1b[45;5u"); // undo the paste; cursor stays at (1, 0)
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });
		editor.handleInput("\x1b[A");

		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
	});
});
