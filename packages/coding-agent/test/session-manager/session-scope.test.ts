import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveSession, getControlDbPath } from "../../src/core/session-control-db.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

function persistSession(cwd: string, sessionDir: string, controlDbPath: string): SessionManager {
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
});
