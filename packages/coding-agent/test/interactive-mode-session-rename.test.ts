import { type Component, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { getControlDbPath, readSessionNameState } from "../src/core/session-control-db.ts";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const CTRL_R = "\x1b[114;5u";
const CTRL_U = "\x15";

type SelectorView = { component: Component; focus: Component };

type SessionSelectorContext = {
	handleResumeSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	keybindings: KeybindingsManager;
	options: { controlDbPath?: string };
	renameSessionFromSelector: (sessionFilePath: string, nextName: string | undefined) => void;
	session: Harness["session"];
	sessionManager: Harness["sessionManager"];
	showSelector: (create: (done: () => void) => SelectorView) => void;
	shutdown: () => Promise<void>;
	sortNamedSessionsFirst: (sessions: SessionInfo[]) => SessionInfo[];
	ui: { requestRender: () => void };
};

type InteractiveModePrivate = {
	renameSessionFromSelector(this: SessionSelectorContext, sessionFilePath: string, nextName: string | undefined): void;
	showSessionSelector(this: SessionSelectorContext): void;
	sortNamedSessionsFirst(this: SessionSelectorContext, sessions: SessionInfo[]): SessionInfo[];
};

const interactiveMode = InteractiveMode.prototype as unknown as InteractiveModePrivate;

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

async function openSessionSelector(harness: Harness): Promise<SessionSelectorComponent> {
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	let selector: SessionSelectorComponent | undefined;
	const context: SessionSelectorContext = {
		handleResumeSession: vi.fn(async () => ({ cancelled: false })),
		keybindings,
		options: { controlDbPath: getControlDbPath(harness.tempDir) },
		renameSessionFromSelector: interactiveMode.renameSessionFromSelector,
		session: harness.session,
		sessionManager: harness.sessionManager,
		showSelector: (create) => {
			const view = create(() => {});
			if (!(view.component instanceof SessionSelectorComponent)) {
				throw new Error("Expected session selector component");
			}
			selector = view.component;
		},
		shutdown: vi.fn(async () => {}),
		sortNamedSessionsFirst: interactiveMode.sortNamedSessionsFirst,
		ui: { requestRender: vi.fn() },
	};

	interactiveMode.showSessionSelector.call(context);
	await flushPromises();
	await flushPromises();
	if (!selector) throw new Error("Session selector was not created");
	return selector;
}

async function submitRename(selector: SessionSelectorComponent, name?: string): Promise<void> {
	selector.getSessionList().handleInput(CTRL_R);
	await flushPromises();
	if (name === undefined) {
		selector.handleInput(CTRL_U);
	} else {
		for (const character of name) selector.handleInput(character);
	}
	selector.handleInput("\r");
	await flushPromises();
	await flushPromises();
}

describe("InteractiveMode session selector rename", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("synchronizes active-session rename and clear with runtime state and events", async () => {
		const harness = await createHarness({ persistedSession: true });
		try {
			harness.sessionManager.persistForRecovery();
			const sessionFile = harness.session.sessionFile;
			if (!sessionFile) throw new Error("Expected persisted session file");
			const controlDbPath = getControlDbPath(harness.tempDir);
			const sessionInfo: SessionInfo = {
				path: sessionFile,
				id: harness.sessionManager.getSessionId(),
				cwd: harness.sessionManager.getCwd(),
				created: new Date("2026-08-23T00:00:00.000Z"),
				modified: new Date("2026-08-23T00:00:00.000Z"),
				messageCount: 1,
				firstMessage: "current session",
				allMessagesText: "current session",
			};
			vi.spyOn(SessionManager, "list").mockResolvedValue([sessionInfo]);
			vi.spyOn(SessionManager, "listAll").mockResolvedValue([sessionInfo]);
			vi.spyOn(SessionManager, "listArchived").mockResolvedValue([]);

			const renameSelector = await openSessionSelector(harness);
			expect(renameSelector.getSessionList().getSelectedSessionPath()).toBe(sessionFile);
			await submitRename(renameSelector, "Active Session");

			expect(harness.sessionManager.getSessionName()).toBe("Active Session");
			expect(harness.sessionManager.hasSessionNameState()).toBe(true);
			expect(readSessionNameState(controlDbPath, sessionFile)).toEqual({
				name: "Active Session",
				hasStoredValue: true,
			});
			expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["Active Session"]);

			const clearSelector = await openSessionSelector(harness);
			await submitRename(clearSelector);

			expect(harness.sessionManager.getSessionName()).toBeUndefined();
			expect(harness.sessionManager.hasSessionNameState()).toBe(true);
			expect(readSessionNameState(controlDbPath, sessionFile)).toEqual({
				name: undefined,
				hasStoredValue: true,
			});
			expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual([
				"Active Session",
				undefined,
			]);
		} finally {
			vi.restoreAllMocks();
			harness.cleanup();
		}
	});
});
