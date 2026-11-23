import { describe, expect, it } from "vitest";
import { type Component, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const createExtensionUIContext = (
	InteractiveMode.prototype as unknown as { createExtensionUIContext(this: unknown): ExtensionUIContext }
).createExtensionUIContext;

/** Minimal editor: shows its text and treats bracketed paste input as appended text. */
class TextEditor implements Component {
	text = "initial";
	setText(text: string): void {
		this.text = text;
	}
	getText(): string {
		return this.text;
	}
	handleInput(data: string): void {
		this.text += data.replace("\x1b[200~", "").replace("\x1b[201~", "");
	}
	invalidate(): void {}
	render(): string[] {
		return [this.text];
	}
}

async function renderedAfterIdleCall(call: (ui: ExtensionUIContext) => void): Promise<string> {
	const terminal = new VirtualTerminal(40, 5);
	const tui = new TUI(terminal);
	const editor = new TextEditor();
	tui.addChild(editor);
	tui.start();
	try {
		tui.requestRender(true);
		await terminal.waitForRender();
		// Called outside terminal input handling, e.g. after an await in a command handler (upstream #12295).
		call(createExtensionUIContext.call({ editor, ui: tui }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		await terminal.flush();
		return terminal.getViewport().join("\n");
	} finally {
		tui.stop();
	}
}

describe("extension editor updates outside input handling", () => {
	it("repaints after setEditorText", async () => {
		expect(await renderedAfterIdleCall((ui) => ui.setEditorText("from extension"))).toContain("from extension");
	});

	it("repaints after pasteToEditor", async () => {
		expect(await renderedAfterIdleCall((ui) => ui.pasteToEditor(" pasted"))).toContain("initial pasted");
	});
});
