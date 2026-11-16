import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type Component, Container, type Focusable, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class EditorStub implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	handleInput(data: string): void {
		this.inputs.push(data);
	}
	render(): string[] {
		return ["EDITOR"];
	}
	invalidate(): void {}
}

interface DialogInternals {
	showExtensionSelector(
		this: unknown,
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal },
	): Promise<string | undefined>;
}

const dialogs = InteractiveMode.prototype as unknown as DialogInternals &
	Record<"openEditorDialog" | "closeEditorDialog" | "showTopEditorDialog", unknown>;

// Two extension dialogs open at once, e.g. approvals for parallel tool calls (#11166).
describe("stacked extension dialogs", () => {
	let terminal: VirtualTerminal;
	let ui: TUI;
	let editor: EditorStub;
	let mode: Record<string, unknown>;

	beforeAll(() => initTheme("dark"));

	beforeEach(() => {
		terminal = new VirtualTerminal(80, 24);
		ui = new TUI(terminal);
		editor = new EditorStub();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		ui.addChild(editorContainer);
		ui.setFocus(editor);
		mode = {
			ui,
			editor,
			editorContainer,
			keybindings: new KeybindingsManager(),
			editorDialogs: [],
			restoreEditorSlotAfterDialogs: undefined,
			openEditorDialog: dialogs.openEditorDialog,
			closeEditorDialog: dialogs.closeEditorDialog,
			showTopEditorDialog: dialogs.showTopEditorDialog,
			toggleToolOutputExpansion: () => {},
		};
		ui.start();
	});

	afterEach(() => ui.stop());

	async function pressEnter(): Promise<void> {
		terminal.sendInput("\r");
		ui.requestRender(true);
		await Promise.resolve();
		await terminal.waitForRender();
	}

	function visibleText(): string {
		return (mode.editorContainer as Container).render(80).join("\n");
	}

	test("answering both dialogs, newest first, gives the editor back", async () => {
		const first = dialogs.showExtensionSelector.call(mode, "First?", ["A1", "A2"]);
		const second = dialogs.showExtensionSelector.call(mode, "Second?", ["B1", "B2"]);
		expect(visibleText()).toContain("Second?");

		await pressEnter();
		await expect(second).resolves.toBe("B1");
		expect(visibleText()).toContain("First?");

		await pressEnter();
		await expect(first).resolves.toBe("A1");
		expect(visibleText()).toBe("EDITOR");
		terminal.sendInput("x");
		expect(editor.inputs).toContain("x");
	});

	test("closing a covered dialog keeps the visible one open and answerable", async () => {
		const abort = new AbortController();
		const first = dialogs.showExtensionSelector.call(mode, "First?", ["A1"], { signal: abort.signal });
		const second = dialogs.showExtensionSelector.call(mode, "Second?", ["B1"]);

		abort.abort();
		await expect(first).resolves.toBeUndefined();
		expect(visibleText()).toContain("Second?");

		await pressEnter();
		await expect(second).resolves.toBe("B1");
		expect(visibleText()).toBe("EDITOR");
	});
});
