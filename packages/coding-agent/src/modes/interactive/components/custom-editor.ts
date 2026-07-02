import { existsSync, readFileSync } from "node:fs";
import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { readOrMigratePromptHistory, recordPromptHistoryEntry } from "../../../core/session-control-db.ts";

export interface CustomEditorOptions extends EditorOptions {
	legacyPromptHistoryPath?: string;
	promptHistoryControlDbPath?: string;
}

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private readonly promptHistoryControlDbPath?: string;
	public actionHandlers: Map<AppKeybinding, () => unknown> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.promptHistoryControlDbPath = options?.promptHistoryControlDbPath;
		if (this.promptHistoryControlDbPath) {
			this.setHistory(loadPromptHistory(this.promptHistoryControlDbPath, options?.legacyPromptHistoryPath));
		}
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => unknown): void {
		this.actionHandlers.set(action, handler);
	}

	override addToHistory(text: string): void {
		const before = this.getHistory();
		super.addToHistory(text);
		this.recordNewestHistoryEntry(before);
	}

	addToHistoryWithoutPersistence(text: string): void {
		super.addToHistory(text);
	}

	private recordNewestHistoryEntry(previousHistory: string[]): void {
		const history = this.getHistory();
		const newestHistoryEntry = history[0];
		if (
			this.promptHistoryControlDbPath &&
			newestHistoryEntry !== undefined &&
			!sameHistory(previousHistory, history)
		) {
			recordPromptHistoryEntry(this.promptHistoryControlDbPath, newestHistoryEntry);
		}
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				if (handler() !== false) {
					return;
				}
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}

function loadPromptHistory(controlDbPath: string, legacyPromptHistoryPath: string | undefined): string[] {
	const legacyPromptHistory = readLegacyPromptHistory(legacyPromptHistoryPath);
	return readOrMigratePromptHistory(controlDbPath, legacyPromptHistory);
}

function readLegacyPromptHistory(path: string | undefined): string[] {
	if (!path || !existsSync(path)) return [];

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 100);
	} catch {
		return [];
	}
}

function sameHistory(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
