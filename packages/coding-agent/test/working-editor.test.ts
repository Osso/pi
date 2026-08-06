import assert from "node:assert/strict";
import type { EditorComponent, LoaderIndicatorOptions } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import {
	clearWorkingEditor,
	positionWorkingEditor,
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

	it("leaves arbitrary custom editors unchanged", () => {
		const editor = new PlainEditor();

		syncWorkingEditor(editor, true, { frames: ["x"] });
		positionWorkingEditor(editor, { row: 3, col: 1 });
		clearWorkingEditor(editor);

		assert.deepStrictEqual(editor.render(20), ["plain"]);
	});
});
