import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

function createEditor(historyPath: string): CustomEditor {
	return new CustomEditor(new TUI(new VirtualTerminal()), defaultEditorTheme, KeybindingsManager.create(), {
		promptHistoryPath: historyPath,
	});
}

describe("CustomEditor prompt history persistence", () => {
	let tempDir: string;
	let historyPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-prompt-history-"));
		historyPath = join(tempDir, "nested", "prompt-history.json");
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("loads persisted prompt history for up-arrow navigation", () => {
		mkdirSync(join(tempDir, "nested"), { recursive: true });
		writeFileSync(historyPath, JSON.stringify(["recent prompt", "older prompt"]));
		const editor = createEditor(historyPath);

		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("recent prompt");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("older prompt");
	});

	it("writes the newest 100 submitted prompts to disk", () => {
		const editor = createEditor(historyPath);

		for (let index = 0; index < 105; index++) {
			editor.addToHistory(`prompt ${index}`);
		}

		const history = JSON.parse(readFileSync(historyPath, "utf8")) as string[];
		expect(history).toHaveLength(100);
		expect(history[0]).toBe("prompt 104");
		expect(history[99]).toBe("prompt 5");
	});
});
