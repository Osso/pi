import assert from "node:assert/strict";
import { type EditorComponent, type LoaderIndicatorOptions, TUI } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	clearWorkingEditor,
	positionWorkingEditor,
	supportsWorkingPromptAnimation,
	syncWorkingEditor,
} from "../src/modes/interactive/working-editor.ts";

class TestEditor implements EditorComponent {
	working = false;
	indicator: LoaderIndicatorOptions | undefined;
	origin: { row: number; col: number } | undefined;

	render(_width: number): string[] {
		return [`${this.working ? "working" : "idle"}:${this.indicator?.frames?.join("") ?? "default"}`];
	}

	invalidate(): void {}
	handleInput(_data: string): void {}
	getText(): string {
		return "";
	}
	setText(_text: string): void {}
	setWorking(working: boolean): void {
		this.working = working;
	}
	setWorkingIndicator(indicator?: LoaderIndicatorOptions): void {
		this.indicator = indicator;
	}
	setScreenOrigin(row: number, col: number): void {
		this.origin = { row, col };
	}
	clearScreenOrigin(): void {
		this.origin = undefined;
	}
}

class PlainEditor implements EditorComponent {
	render(_width: number): string[] {
		return ["plain"];
	}
	invalidate(): void {}
	handleInput(_data: string): void {}
	getText(): string {
		return "";
	}
	setText(_text: string): void {}
}

describe("working editor integration", () => {
	it("synchronizes indicator options and working state for capable editors", () => {
		const editor = new TestEditor();
		const indicator = { frames: ["a", "b"], intervalMs: 120 };

		syncWorkingEditor(editor, true, indicator);

		assert.deepStrictEqual(editor.indicator, indicator);
		assert.strictEqual(editor.working, true);
		assert.deepStrictEqual(editor.render(20), ["working:ab"]);
	});

	it("positions and clears capable editors", () => {
		const editor = new TestEditor();
		syncWorkingEditor(editor, true, undefined);

		positionWorkingEditor(editor, { row: 7, col: 2 });
		assert.deepStrictEqual(editor.origin, { row: 7, col: 2 });

		clearWorkingEditor(editor);
		assert.strictEqual(editor.working, false);
		assert.strictEqual(editor.origin, undefined);
	});

	it("preserves inherited prompt animation in CustomEditor", () => {
		const theme = { ...defaultEditorTheme, promptPrefix: (text: string) => text };
		const editor = new CustomEditor(new TUI(new VirtualTerminal()), theme, KeybindingsManager.create());
		const indicator = { frames: ["x"], intervalMs: 120 };

		editor.render(40);
		positionWorkingEditor(editor, { row: 4, col: 2 });
		syncWorkingEditor(editor, true, indicator);

		assert.strictEqual(supportsWorkingPromptAnimation(editor, indicator), true);
		assert.ok(editor.render(40)[1]?.startsWith("x "));

		clearWorkingEditor(editor);
		assert.ok(editor.render(40)[1]?.startsWith("› "));
	});

	it("leaves arbitrary custom editors unchanged", () => {
		const editor = new PlainEditor();

		syncWorkingEditor(editor, true, { frames: ["x"] });
		positionWorkingEditor(editor, { row: 3, col: 1 });
		clearWorkingEditor(editor);

		assert.deepStrictEqual(editor.render(20), ["plain"]);
	});
});
