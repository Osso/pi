import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("ExtensionEditorComponent external editor", () => {
	let dir: string;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		dir = mkdtempSync(join(tmpdir(), "pi-ext-editor-"));
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
		rmSync(dir, { recursive: true, force: true });
	});

	function createComponent(editorCommand: string): ExtensionEditorComponent {
		const tui = new TUI(new VirtualTerminal(80, 24));
		vi.spyOn(tui, "stop").mockImplementation(() => {});
		vi.spyOn(tui, "start").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		return new ExtensionEditorComponent(
			tui,
			new KeybindingsManager(),
			"Edit",
			"draft text",
			() => {},
			() => {},
			undefined,
			editorCommand,
		);
	}

	it("reports an editor program that cannot be started", async () => {
		const missingEditor = join(dir, "missing-editor");
		const component = createComponent(missingEditor);

		component.handleInput("\x07");

		await vi.waitFor(() => {
			expect(stripAnsi(component.render(200).join("\n"))).toContain(
				`External editor failed: could not start ${missingEditor}`,
			);
		});
		expect(unhandled).toEqual([]);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("draft text");
	});

	it("reports an external editor failure instead of rejecting unhandled", async () => {
		// An editor that removes the file and exits 0 makes reading the result fail.
		const editorScript = join(dir, "remove-file-editor.sh");
		writeFileSync(editorScript, '#!/bin/sh\nrm -f "$1"\n');
		chmodSync(editorScript, 0o755);

		const component = createComponent(editorScript);

		component.handleInput("\x07");

		await vi.waitFor(() => {
			expect(stripAnsi(component.render(80).join("\n"))).toContain("External editor failed:");
		});
		expect(unhandled).toEqual([]);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("draft text");
	});
});
