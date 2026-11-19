import type { KeyId } from "@earendil-works/pi-tui";
import type { ExtensionShortcut } from "../../core/extensions/types.ts";
import { formatKeyText, keyDisplayText } from "./components/keybinding-hints.ts";

/** Markdown body of /hotkeys: built-in editor and app keys, then extension shortcuts. */
export function formatHotkeysMarkdown(shortcuts: ReadonlyMap<KeyId, ExtensionShortcut>): string {
	// Navigation keybindings
	const cursorUp = keyDisplayText("tui.editor.cursorUp");
	const cursorDown = keyDisplayText("tui.editor.cursorDown");
	const cursorLeft = keyDisplayText("tui.editor.cursorLeft");
	const cursorRight = keyDisplayText("tui.editor.cursorRight");
	const cursorWordLeft = keyDisplayText("tui.editor.cursorWordLeft");
	const cursorWordRight = keyDisplayText("tui.editor.cursorWordRight");
	const cursorLineStart = keyDisplayText("tui.editor.cursorLineStart");
	const cursorLineEnd = keyDisplayText("tui.editor.cursorLineEnd");
	const jumpForward = keyDisplayText("tui.editor.jumpForward");
	const jumpBackward = keyDisplayText("tui.editor.jumpBackward");
	const pageUp = keyDisplayText("tui.editor.pageUp");
	const pageDown = keyDisplayText("tui.editor.pageDown");

	// Editing keybindings
	const submit = keyDisplayText("tui.input.submit");
	const newLine = keyDisplayText("tui.input.newLine");
	const deleteWordBackward = keyDisplayText("tui.editor.deleteWordBackward");
	const deleteWordForward = keyDisplayText("tui.editor.deleteWordForward");
	const deleteToLineStart = keyDisplayText("tui.editor.deleteToLineStart");
	const deleteToLineEnd = keyDisplayText("tui.editor.deleteToLineEnd");
	const yank = keyDisplayText("tui.editor.yank");
	const yankPop = keyDisplayText("tui.editor.yankPop");
	const undo = keyDisplayText("tui.editor.undo");
	const tab = keyDisplayText("tui.input.tab");

	// App keybindings
	const interrupt = keyDisplayText("app.interrupt");
	const clear = keyDisplayText("app.clear");
	const exit = keyDisplayText("app.exit");
	const suspend = keyDisplayText("app.suspend");
	const cycleThinkingLevel = keyDisplayText("app.thinking.cycle");
	const cycleModelForward = keyDisplayText("app.model.cycleForward");
	const selectModel = keyDisplayText("app.model.select");
	const expandTools = keyDisplayText("app.tools.expand");
	const toggleThinking = keyDisplayText("app.thinking.toggle");
	const externalEditor = keyDisplayText("app.editor.external");
	const cycleModelBackward = keyDisplayText("app.model.cycleBackward");
	const followUp = keyDisplayText("app.message.followUp");
	const dequeue = keyDisplayText("app.message.dequeue");
	const pasteImage = keyDisplayText("app.clipboard.pasteImage");
	const selectAgent = keyDisplayText("app.agent.select");

	let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`${selectAgent}\` | Open agent switcher |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

	// Add extension-registered shortcuts
	if (shortcuts.size > 0) {
		hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
		for (const [key, shortcut] of shortcuts) {
			const description = shortcut.description ?? shortcut.extensionPath;
			const keyDisplay = formatKeyText(key, { capitalize: true });
			hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
		}
	}
	return hotkeys.trim();
}
