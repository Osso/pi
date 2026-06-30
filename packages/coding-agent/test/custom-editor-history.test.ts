import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { recordPromptHistoryEntry } from "../src/core/session-control-db.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

function createEditor(controlDbPath: string, legacyPromptHistoryPath?: string): CustomEditor {
	return new CustomEditor(new TUI(new VirtualTerminal()), defaultEditorTheme, KeybindingsManager.create(), {
		legacyPromptHistoryPath,
		promptHistoryControlDbPath: controlDbPath,
	});
}

describe("CustomEditor prompt history persistence", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-prompt-history-"));
		controlDbPath = join(tempDir, "control.sqlite");
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("loads persisted prompt history for up-arrow navigation", () => {
		recordPromptHistoryEntry(controlDbPath, "older prompt");
		recordPromptHistoryEntry(controlDbPath, "recent prompt");
		const editor = createEditor(controlDbPath);

		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("recent prompt");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("older prompt");
	});

	it("migrates existing JSON prompt history when SQLite history is empty", () => {
		const legacyPromptHistoryPath = join(tempDir, "nested", "prompt-history.json");
		mkdirSync(join(tempDir, "nested"), { recursive: true });
		writeFileSync(legacyPromptHistoryPath, JSON.stringify(["recent prompt", "older prompt"]));
		const editor = createEditor(controlDbPath, legacyPromptHistoryPath);

		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("recent prompt");
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("older prompt");
	});

	it("does not persist history populated from rendered transcripts", () => {
		const editor = createEditor(controlDbPath);

		editor.addToHistoryWithoutPersistence("old transcript prompt");
		const reloadedEditor = createEditor(controlDbPath);

		reloadedEditor.handleInput("\x1b[A");
		expect(reloadedEditor.getText()).toBe("");
	});

	it("merges prompt history written by concurrent editors", () => {
		const firstEditor = createEditor(controlDbPath);
		const secondEditor = createEditor(controlDbPath);

		firstEditor.addToHistory("first prompt");
		secondEditor.addToHistory("second prompt");
		const reloadedEditor = createEditor(controlDbPath);

		reloadedEditor.handleInput("\x1b[A");
		expect(reloadedEditor.getText()).toBe("second prompt");
		reloadedEditor.handleInput("\x1b[A");
		expect(reloadedEditor.getText()).toBe("first prompt");
	});

	it("loads the newest 100 submitted prompts", () => {
		const editor = createEditor(controlDbPath);

		for (let index = 0; index < 105; index++) {
			editor.addToHistory(`prompt ${index}`);
		}

		const reloadedEditor = createEditor(controlDbPath);
		reloadedEditor.handleInput("\x1b[A");
		expect(reloadedEditor.getText()).toBe("prompt 104");

		for (let index = 0; index < 99; index++) {
			reloadedEditor.handleInput("\x1b[A");
		}
		expect(reloadedEditor.getText()).toBe("prompt 5");
	});
});
