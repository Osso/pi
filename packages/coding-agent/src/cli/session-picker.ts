/**
 * TUI session selector for --resume flag
 */

import { setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import { listNamedSessions } from "../core/session-control-db.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import { createStartupTui, startStartupTui } from "./startup-ui.ts";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
	controlDbPath?: string,
	archivedSessionsLoader?: SessionsLoader,
): Promise<string | null> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			(onProgress) => loadSessionsWithControlNames(currentSessionsLoader, controlDbPath, onProgress),
			(onProgress) => loadSessionsWithControlNames(allSessionsLoader, controlDbPath, onProgress),
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
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
					? (onProgress) => loadSessionsWithControlNames(archivedSessionsLoader, controlDbPath, onProgress, true)
					: undefined,
			},
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		startStartupTui(ui, settingsManager);
	});
}

async function loadSessionsWithControlNames(
	loader: SessionsLoader,
	controlDbPath: string | undefined,
	onProgress?: SessionListProgress,
	archived = false,
): Promise<SessionInfo[]> {
	const sessions = await loader(onProgress);
	const filteredSessions = archived
		? sessions.filter((session) => session.isArchived)
		: sessions.filter((session) => !session.isArchived);
	if (!controlDbPath) return filteredSessions;

	const names = new Map(listNamedSessions(controlDbPath).map((session) => [session.sessionPath, session.name]));
	return filteredSessions
		.map((session) => ({ ...session, name: names.get(session.path) ?? session.name }))
		.sort((a, b) => {
			const aNamed = names.has(a.path);
			const bNamed = names.has(b.path);
			if (aNamed !== bNamed) return aNamed ? -1 : 1;
			return b.modified.getTime() - a.modified.getTime();
		});
}
