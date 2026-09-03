/**
 * TUI session selector for --resume flag
 */

import { setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import { isResidentSession } from "../core/resident-session.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import { createStartupTui, startStartupTui } from "./startup-ui.ts";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;
type SelectionValidator = (sessionPath: string) => void;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
	controlDbPath?: string,
	archivedSessionsLoader?: SessionsLoader,
	validateSelection?: SelectionValidator,
): Promise<string | null> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			(onProgress) => loadSessions(currentSessionsLoader, onProgress),
			(onProgress) => loadSessions(allSessionsLoader, onProgress),
			(path: string) => {
				if (resolved) return;
				try {
					validateSelection?.(path);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					selector.showError(message);
					return;
				}
				resolved = true;
				ui.stop();
				resolve(path);
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{
				showRenameHint: false,
				keybindings,
				controlDbPath,
				archivedSessionsLoader: archivedSessionsLoader
					? (onProgress) => loadSessions(archivedSessionsLoader, onProgress, true)
					: undefined,
			},
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		startStartupTui(ui, settingsManager);
	});
}

async function loadSessions(
	loader: SessionsLoader,
	onProgress?: SessionListProgress,
	archived = false,
): Promise<SessionInfo[]> {
	const sessions = await loader(onProgress);
	return sessions
		.filter((session) => !isResidentSession(session))
		.filter((session) => (archived ? session.isArchived : !session.isArchived))
		.sort((a, b) => {
			const aNamed = Boolean(a.name?.trim());
			const bNamed = Boolean(b.name?.trim());
			if (!archived && aNamed !== bNamed) return aNamed ? -1 : 1;
			return b.modified.getTime() - a.modified.getTime();
		});
}
