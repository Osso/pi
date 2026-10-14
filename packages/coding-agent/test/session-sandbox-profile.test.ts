import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { setKeybindings } from "@earendil-works/pi-tui";
import * as childProcess from "child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import {
	clearSessionSandboxProfile,
	getControlDbPath,
	readSessionSandboxProfile,
	relocateSessionControlData,
	removeSessionMetadata,
	writeSessionMetadata,
	writeSessionSandboxProfile,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";
import type { SandboxSelectorComponent } from "../src/modes/interactive/components/sandbox-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

function writeTestSessionMetadata(controlDbPath: string, sessionPath: string, sessionId: string): void {
	writeSessionMetadata(controlDbPath, {
		createdAt: "2026-08-09T00:00:00.000Z",
		cwd: "/repo",
		firstMessage: "",
		id: sessionId,
		messageCount: 0,
		modifiedAt: "2026-08-09T00:00:00.000Z",
		sessionPath,
	});
}

type StatusProfile = "read-only" | "workspace-write" | "full-access" | undefined;

function createStatusFixture(tempDir: string) {
	const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
	sessionManager.setMetadataControlDbPath(getControlDbPath(tempDir));
	sessionManager.setSessionSandboxProfile("workspace-write");
	const settingsManager = SettingsManager.inMemory({ sandboxProfile: "full-access" });
	settingsManager.setSessionSandboxProfile("workspace-write");
	const runner = new ExtensionRunner(
		[],
		createExtensionRuntime(),
		tempDir,
		sessionManager,
		ModelRegistry.create(AuthStorage.create(join(tempDir, "auth.json"))),
		settingsManager,
	);
	const setStatus = vi.fn();
	runner.setUIContext({ ...runner.getUIContext(), setStatus, theme }, "tui");
	return { sessionManager, settingsManager, runner, setStatus };
}

function driveSandboxSelector(fixture: ReturnType<typeof createStatusFixture>, profile: StatusProfile): void {
	const uiContext = {
		settingsManager: fixture.settingsManager,
		session: { extensionRunner: fixture.runner },
		setExtensionStatus: fixture.setStatus,
		updateBwrapStatusForSandboxProfile: Reflect.get(InteractiveMode.prototype, "updateBwrapStatusForSandboxProfile"),
		showStatus: () => {},
		showSelector: (factory: (done: () => void) => { component: SandboxSelectorComponent }) => {
			const { component } = factory(() => {});
			component.handleInput("\t");
			component.handleInput("\t");
			component.handleInput("k");
			component.handleInput("k");
			const steps = [undefined, "read-only", "workspace-write", "full-access"].indexOf(profile);
			for (let step = 0; step < steps; step++) component.handleInput("j");
			component.handleInput("\n");
		},
	};
	Reflect.get(InteractiveMode.prototype, "showSandboxSelector").call(uiContext);
}

function setSandboxProfileThroughRoute(
	fixture: ReturnType<typeof createStatusFixture>,
	profile: StatusProfile,
	route: "runner" | "selector",
): void {
	if (route === "runner") {
		fixture.runner.createCommandContext().setSandboxProfile(profile, "session");
		return;
	}
	driveSandboxSelector(fixture, profile);
}

describe.each(["runner", "selector"] as const)("sandbox status through %s", (route) => {
	let tempDir: string;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sandbox-status-"));
		setKeybindings(new KeybindingsManager());
		vi.mocked(childProcess.spawnSync).mockClear();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.mocked(childProcess.spawnSync).mockReset();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each([
		{ platform: "darwin", profile: "read-only", color: "error", text: "bwrap unsupported on darwin" },
		{ platform: "darwin", profile: "workspace-write", color: "error", text: "bwrap unsupported on darwin" },
		{ platform: "darwin", profile: "full-access", color: "muted", text: "bwrap: full access" },
		{ platform: "darwin", profile: undefined, color: "muted", text: "bwrap: full access" },
		{ platform: "linux", profile: "read-only", color: "accent", text: "bwrap: read-only" },
		{ platform: "linux", profile: "workspace-write", color: "accent", text: "bwrap: workspace-write" },
		{ platform: "linux", profile: "full-access", color: "muted", text: "bwrap: full access" },
		{ platform: "linux", profile: undefined, color: "muted", text: "bwrap: full access" },
		{ platform: "linux", profile: "read-only", color: "error", text: "bwrap unavailable" },
	] as const)(
		"displays $text for $profile on $platform without changing the choice",
		({ platform, profile, color, text }) => {
			vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
			vi.mocked(childProcess.spawnSync).mockReturnValue({
				status: text === "bwrap unavailable" ? 1 : 0,
				stdout: Buffer.alloc(0),
				stderr: Buffer.alloc(0),
				pid: 1,
				output: [null, Buffer.alloc(0), Buffer.alloc(0)],
				signal: null,
			});
			const fixture = createStatusFixture(tempDir);
			const { sessionManager, settingsManager, setStatus } = fixture;
			setSandboxProfileThroughRoute(fixture, profile, route);
			const runnerOnlyMissingBwrap = route === "runner" && text === "bwrap unavailable";
			const expectedStatus = runnerOnlyMissingBwrap ? theme.fg("accent", "bwrap: read-only") : theme.fg(color, text);
			expect(setStatus).toHaveBeenLastCalledWith("bwrap", expectedStatus);
			expect(settingsManager.getSessionSandboxProfile()).toBe(profile);
			expect(settingsManager.getExplicitSandboxProfile()).toBe(profile ?? "full-access");
			expect(sessionManager.readPersistedSessionSettings()?.sandboxProfile).toBe(profile);
			const isProtectedProfile = profile === "read-only" || profile === "workspace-write";
			const requiresLinuxProbe = platform === "linux" && isProtectedProfile;
			const probes = route === "selector" && requiresLinuxProbe ? 1 : 0;
			expect(childProcess.spawnSync).toHaveBeenCalledTimes(probes);
		},
	);
});

describe("session sandbox profile control state", () => {
	let tempDir: string;
	let controlDbPath: string;
	const sessionId = "session-a";
	const sessionPath = "/tmp/session-a.jsonl";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-sandbox-profile-"));
		controlDbPath = getControlDbPath(tempDir);
		writeTestSessionMetadata(controlDbPath, sessionPath, sessionId);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("persists, replaces, and clears one override for the exact session", () => {
		writeSessionSandboxProfile(controlDbPath, sessionPath, sessionId, "read-only");
		expect(readSessionSandboxProfile(controlDbPath, sessionPath, sessionId)).toBe("read-only");

		writeSessionSandboxProfile(controlDbPath, sessionPath, sessionId, "full-access");
		expect(readSessionSandboxProfile(controlDbPath, sessionPath, sessionId)).toBe("full-access");

		clearSessionSandboxProfile(controlDbPath, sessionPath, sessionId);
		expect(readSessionSandboxProfile(controlDbPath, sessionPath, sessionId)).toBeUndefined();
	});

	it("rejects session identity mismatches instead of inheriting silently", () => {
		expect(() => writeSessionSandboxProfile(controlDbPath, sessionPath, "other-session", "read-only")).toThrow(
			/session identity/i,
		);

		writeSessionSandboxProfile(controlDbPath, sessionPath, sessionId, "read-only");
		expect(() => readSessionSandboxProfile(controlDbPath, sessionPath, "other-session")).toThrow(/session identity/i);
		expect(() => clearSessionSandboxProfile(controlDbPath, sessionPath, "other-session")).toThrow(
			/session identity/i,
		);
	});

	it("rejects invalid persisted profiles", () => {
		expect(() =>
			writeSessionSandboxProfile(controlDbPath, sessionPath, sessionId, "invalid-profile" as never),
		).toThrow(/invalid sandbox profile/i);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare(
				"INSERT INTO session_sandbox_profiles (session_path, session_id, profile, updated_at) VALUES (?, ?, ?, ?)",
			).run(sessionPath, sessionId, "invalid-profile", "2026-08-09T00:00:00.000Z");
		} finally {
			db.close();
		}

		expect(() => readSessionSandboxProfile(controlDbPath, sessionPath, sessionId)).toThrow(
			/invalid sandbox profile/i,
		);
	});

	it("rejects orphaned overrides instead of falling back to broader access", () => {
		const workspaceDir = join(tempDir, "orphan-workspace");
		const sessionDir = join(tempDir, "orphan-sessions");
		mkdirSync(workspaceDir, { recursive: true });
		const session = SessionManager.create(workspaceDir, sessionDir, { id: sessionId });
		session.setMetadataControlDbPath(controlDbPath);
		session.setSessionSandboxProfile("read-only");
		const persistedPath = session.getSessionFile();
		if (!persistedPath) throw new Error("Expected persisted session file");
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare("DELETE FROM session_metadata WHERE session_path = ?").run(persistedPath);
		} finally {
			db.close();
		}

		expect(() => session.readPersistedSessionSettings()).toThrow(/session metadata is missing/i);
	});

	it("follows canonical session relocation and cleanup", () => {
		const relocatedPath = "/tmp/relocated-session-a.jsonl";
		writeSessionSandboxProfile(controlDbPath, sessionPath, sessionId, "workspace-write");

		relocateSessionControlData(controlDbPath, sessionPath, relocatedPath);

		expect(readSessionSandboxProfile(controlDbPath, sessionPath, sessionId)).toBeUndefined();
		expect(readSessionSandboxProfile(controlDbPath, relocatedPath, sessionId)).toBe("workspace-write");

		removeSessionMetadata(controlDbPath, relocatedPath);
		expect(readSessionSandboxProfile(controlDbPath, relocatedPath, sessionId)).toBeUndefined();
	});

	it("restores the override before runtime construction and clears it for forked and new sessions", async () => {
		const workspaceDir = join(tempDir, "workspace");
		const sessionDir = join(tempDir, "sessions");
		const agentDir = join(tempDir, "agent");
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const settingsManager = SettingsManager.inMemory({ sandboxProfile: "full-access" });
		const original = SessionManager.create(workspaceDir, sessionDir, { id: sessionId });
		original.setMetadataControlDbPath(controlDbPath);
		original.setSessionSandboxProfile("read-only");
		const sessionFile = original.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const restored = SessionManager.open(sessionFile, sessionDir);
		restored.setMetadataControlDbPath(controlDbPath);

		const firstRuntime = await createAgentSession({
			agentDir,
			cwd: workspaceDir,
			model,
			noTools: "all",
			sessionManager: restored,
			settingsManager,
		});
		expect(restored.readPersistedSessionSettings()?.sandboxProfile).toBe("read-only");
		expect(settingsManager.getExplicitSandboxProfile()).toBe("read-only");
		firstRuntime.session.dispose();

		const forkedSession = SessionManager.forkFrom(sessionFile, workspaceDir, sessionDir, { id: "session-fork" });
		forkedSession.setMetadataControlDbPath(controlDbPath);
		const forkedRuntime = await createAgentSession({
			agentDir,
			cwd: workspaceDir,
			model,
			noTools: "all",
			sessionManager: forkedSession,
			settingsManager,
		});
		expect(settingsManager.getSessionSandboxProfile()).toBeUndefined();
		expect(settingsManager.getExplicitSandboxProfile()).toBe("full-access");
		forkedRuntime.session.dispose();

		const nextSession = SessionManager.create(workspaceDir, sessionDir, { id: "session-b" });
		nextSession.setMetadataControlDbPath(controlDbPath);
		const secondRuntime = await createAgentSession({
			agentDir,
			cwd: workspaceDir,
			model,
			noTools: "all",
			sessionManager: nextSession,
			settingsManager,
		});
		expect(settingsManager.getSessionSandboxProfile()).toBeUndefined();
		expect(settingsManager.getExplicitSandboxProfile()).toBe("full-access");
		secondRuntime.session.dispose();
	});
});
