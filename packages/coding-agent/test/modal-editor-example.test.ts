import { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import modalEditor from "../examples/extensions/modal-editor.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

type EditorFactory = (tui: TUI, theme: typeof defaultEditorTheme, kb: KeybindingsManager) => CustomEditor;

function createModalEditor(): CustomEditor {
	let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
	const api = {
		on: (event: string, handler: typeof sessionStart) => {
			if (event === "session_start") sessionStart = handler;
		},
	} as unknown as ExtensionAPI;
	modalEditor(api);

	let factory: EditorFactory | undefined;
	const ctx = {
		ui: {
			setEditorComponent: (f: EditorFactory) => {
				factory = f;
			},
		},
	} as unknown as ExtensionContext;
	sessionStart!({ type: "session_start" }, ctx);
	return factory!(new TUI(new VirtualTerminal()), defaultEditorTheme, KeybindingsManager.create());
}

describe("modal-editor example", () => {
	it("maps own normal-mode keys", () => {
		const editor = createModalEditor();
		editor.handleInput("abc");
		editor.handleInput("\x1b");
		editor.handleInput("h");
		editor.handleInput("x");
		expect(editor.getText()).toBe("ab");
	});

	it("treats inherited Object property names as plain input in normal mode", () => {
		const editor = createModalEditor();
		editor.handleInput("\x1b");
		expect(() => editor.handleInput("constructor")).not.toThrow();
		expect(() => editor.handleInput("toString")).not.toThrow();
		expect(editor.getText()).toBe("constructortoString");
	});
});
