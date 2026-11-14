import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSession, getControlDbPath, readSessionMetadata } from "../../src/core/session-control-db.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

function persistSession(cwd: string, sessionDir: string, controlDbPath?: string): SessionManager {
	const session = SessionManager.create(cwd, sessionDir);
	session.setMetadataControlDbPath(controlDbPath);
	session.appendMessage({ role: "user", content: "Scope regression", timestamp: 1 });
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Saved" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	return session;
}

describe("session directory metadata scope", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-scope-"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each(["relative", "absolute"])("lists indexed sessions with a non-normalized %s directory", async (kind) => {
		const directory = join(tempDir, "sessions");
		const sessionDir = kind === "relative" ? `./${relative(process.cwd(), directory)}` : `${directory}/.`;
		const cwd = join(tempDir, "project");
		const controlDbPath = getControlDbPath(tempDir);
		const session = persistSession(cwd, sessionDir, controlDbPath);
		const sessionPath = session.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted session");
		expect(existsSync(sessionPath)).toBe(true);
		const expected = [{ id: session.getSessionId(), path: sessionPath }];

		expect(await SessionManager.list(cwd, sessionDir)).toMatchObject(expected);
		expect(await SessionManager.list(cwd, sessionDir, undefined, controlDbPath)).toMatchObject(expected);
		expect(await SessionManager.listAll(sessionDir, undefined, controlDbPath)).toMatchObject(expected);

		archiveSession(controlDbPath, sessionPath);
		expect(await SessionManager.listArchived(sessionDir, undefined, controlDbPath)).toMatchObject(expected);
		expect(await SessionManager.list(cwd, sessionDir, undefined, controlDbPath)).toEqual([]);
		expect(await SessionManager.listAll(sessionDir, undefined, controlDbPath)).toEqual([]);
	});

	it.each([true, false])("continues by metadata cwd after relocation (cwd_changed entry: %s)", (withCwdEntry) => {
		vi.stubEnv("PI_CODING_AGENT_STATE_DIR", tempDir);
		const controlDbPath = getControlDbPath();
		const sessionDir = join(tempDir, "sessions");
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		const session = persistSession(projectA, sessionDir, controlDbPath);
		const sessionPath = session.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted session");

		session.relocate(projectB);
		if (withCwdEntry) {
			session.appendCustomMessageEntry("cwd_changed", `Working directory changed to ${projectB}.`, true, {
				previousCwd: projectA,
				cwd: projectB,
			});
		}
		expect(session.getHeader()?.cwd).toBe(projectA);
		expect(readSessionMetadata(controlDbPath, sessionPath)?.cwd).toBe(projectB);

		const continuedB = SessionManager.continueRecent(projectB, sessionDir);
		expect(continuedB.getSessionId()).toBe(session.getSessionId());
		expect(continuedB.getSessionFile()).toBe(sessionPath);
		expect(continuedB.getCwd()).toBe(projectB);
		const continuedA = SessionManager.continueRecent(projectA, sessionDir);
		expect(continuedA.getSessionId()).not.toBe(session.getSessionId());
		expect(continuedA.getCwd()).toBe(projectA);
	});

	it("continues by header cwd when the session has no metadata row", () => {
		vi.stubEnv("PI_CODING_AGENT_STATE_DIR", tempDir);
		const projectA = join(tempDir, "project-a");
		const sessionDir = join(tempDir, "sessions");
		const session = persistSession(projectA, sessionDir);
		const sessionPath = session.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted session");
		expect(readSessionMetadata(getControlDbPath(), sessionPath)).toBeUndefined();

		const continued = SessionManager.continueRecent(projectA, sessionDir);
		expect(continued.getSessionId()).toBe(session.getSessionId());
		expect(continued.getCwd()).toBe(projectA);
	});
});
