import { type AutocompleteProvider, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

const ALT_ENTER = "\x1b\r";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

function createEditor(provider: AutocompleteProvider): { editor: CustomEditor; followUps: string[] } {
	const keybindings = new KeybindingsManager({ "app.message.followUp": "alt+enter" });
	setKeybindings(keybindings);
	const editor = new CustomEditor(new TUI(new VirtualTerminal()), defaultEditorTheme, keybindings);
	const followUps: string[] = [];
	editor.onAction("app.message.followUp", () => {
		followUps.push(editor.getText().trim());
		editor.setText("");
	});
	editor.setAutocompleteProvider(provider);
	return { editor, followUps };
}

async function typeUntilMenu(editor: CustomEditor, text: string): Promise<void> {
	for (const ch of text) editor.handleInput(ch);
	await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
}

describe("CustomEditor follow-up autocomplete confirmation", () => {
	it("completes a suggested slash command before queuing it as a follow-up", async () => {
		const { editor, followUps } = createEditor({
			getSuggestions: async (lines, cursorLine, cursorCol) => {
				const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
				return prefix.startsWith("/") ? { items: [{ value: "proof", label: "proof" }], prefix } : null;
			},
			applyCompletion: (lines, cursorLine, _cursorCol, item) => ({
				lines: lines.map((line, index) => (index === cursorLine ? `/${item.value} ` : line)),
				cursorLine,
				cursorCol: item.value.length + 2,
			}),
		});
		await typeUntilMenu(editor, "/pro");

		editor.handleInput(ALT_ENTER);

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(followUps).toEqual(["/proof"]);
	});

	it("inserts a non-command completion without queuing, then queues on the next follow-up", async () => {
		const { editor, followUps } = createEditor({
			getSuggestions: async (lines, cursorLine, cursorCol) => {
				const match = (lines[cursorLine] ?? "").slice(0, cursorCol).match(/@\S*$/);
				return match ? { items: [{ value: "@src/foo.ts", label: "src/foo.ts" }], prefix: match[0] } : null;
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				const line = lines[cursorLine] ?? "";
				const next = `${line.slice(0, cursorCol - prefix.length)}${item.value} ${line.slice(cursorCol)}`;
				return {
					lines: lines.map((entry, index) => (index === cursorLine ? next : entry)),
					cursorLine,
					cursorCol: cursorCol - prefix.length + item.value.length + 1,
				};
			},
		});
		await typeUntilMenu(editor, "check @src/fo");

		editor.handleInput(ALT_ENTER);

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(editor.getText()).toBe("check @src/foo.ts ");
		expect(followUps).toEqual([]);

		editor.handleInput(ALT_ENTER);
		expect(followUps).toEqual(["check @src/foo.ts"]);
	});
});
