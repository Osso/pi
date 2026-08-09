import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSessionSandboxProfile,
	getControlDbPath,
	readSessionSandboxProfile,
	relocateSessionControlData,
	removeSessionMetadata,
	writeSessionMetadata,
	writeSessionSandboxProfile,
} from "../src/core/session-control-db.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

function writeTestSessionMetadata(controlDbPath: string, sessionPath: string, sessionId: string): void {
	writeSessionMetadata(controlDbPath, {
		allMessagesText: "",
		createdAt: "2026-08-09T00:00:00.000Z",
		cwd: "/repo",
		firstMessage: "",
		id: sessionId,
		messageCount: 0,
		modifiedAt: "2026-08-09T00:00:00.000Z",
		sessionPath,
	});
}

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
		expect(() => clearSessionSandboxProfile(controlDbPath, sessionPath, "other-session")).toThrow(/session identity/i);
	});

	it("rejects invalid persisted profiles", () => {
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.prepare(
				"INSERT INTO session_sandbox_profiles (session_path, session_id, profile, updated_at) VALUES (?, ?, ?, ?)",
			).run(sessionPath, sessionId, "invalid-profile", "2026-08-09T00:00:00.000Z");
		} finally {
			db.close();
		}

		expect(() => readSessionSandboxProfile(controlDbPath, sessionPath, sessionId)).toThrow(/invalid sandbox profile/i);
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

	it("restores the override before runtime construction and clears it for a new session", async () => {
		const workspaceDir = join(tempDir, "workspace");
		const sessionDir = join(tempDir, "sessions");
		const agentDir = join(tempDir, "agent");
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const settingsManager = SettingsManager.inMemory({ sandboxProfile: "full-access" });
		const original = SessionManager.create(workspaceDir, sessionDir, { id: sessionId });
		original.appendCustomEntry("test-session-created");
		original.persistForRecovery();
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
