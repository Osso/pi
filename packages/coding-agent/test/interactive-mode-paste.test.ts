import { Editor, type EditorComponent, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

// Pastes over 10 lines collapse into a marker whose content only the receiving editor can expand.
const draft = Array.from({ length: 12 }, (_, i) => `draft ${i + 1}`).join("\n");

function editorWithPastedDraft(): EditorComponent {
	const editor = new Editor(new TUI(new VirtualTerminal()), getEditorTheme());
	editor.handleInput(`\x1b[200~${draft}\x1b[201~`);
	// Without a collapsed marker the paths under test would copy plain text and prove nothing.
	expect(editor.getText()).not.toBe(draft);
	return editor;
}

// Upstream #9809: moving a draft out of the editor kept the "[paste #1 ...]" marker instead of the pasted text.
describe("InteractiveMode keeps collapsed paste content when it moves a draft", () => {
	beforeAll(() => initTheme("dark"));

	test("into the interrupt prompt", async () => {
		const interrupt = vi.fn(async (_text: string) => {});
		const host = {
			editor: editorWithPastedDraft(),
			compactionQueuedMessages: [{ text: "queued" }],
			session: { pendingMessageCount: 1, interrupt },
			updatePendingMessagesDisplay() {},
		};
		const cancel = Reflect.get(InteractiveMode.prototype, "cancelStreamingAndSubmitQueuedMessages") as (
			this: typeof host,
		) => Promise<void>;

		await cancel.call(host);

		expect(interrupt).toHaveBeenCalledWith(`queued\n\n${draft}`);
	});

	test("back into the editor with restored queued messages", () => {
		const host = {
			editor: editorWithPastedDraft(),
			clearAllQueues: () => ({ steering: ["queued"], followUp: [] }),
			updatePendingMessagesDisplay() {},
		};
		const restore = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			this: typeof host,
		) => number;

		expect(restore.call(host)).toBe(1);

		expect(host.editor.getText()).toBe(`queued\n\n${draft}`);
	});
});
