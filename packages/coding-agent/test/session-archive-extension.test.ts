import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionArchiveExtension from "../extensions/session-archive/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { archivePersistedSession, restoreArchivedSession } from "../src/core/session-archive-storage.ts";
import { getControlDbPath, readSessionMetadata, writeSessionMetadata } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";

type NewSessionOptions = NonNullable<Parameters<NonNullable<ExtensionCommandContext["newSession"]>>[0]>;
type ReplacedSessionContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

describe("session archive extension", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("registers the archive slash command", () => {
		let command: RegisteredCommand | undefined;
		const pi = {
			registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
				if (name === "archive") {
					command = {
						...options,
						name,
						sourceInfo: {
							path: "<test>",
							source: "test",
							scope: "temporary",
							origin: "top-level",
						},
					};
				}
			},
		} as unknown as ExtensionAPI;

		sessionArchiveExtension(pi);

		expect(command?.description).toContain("Archive the current session");
	});

	it("archives only the current persisted session", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-session-archive-command-"));
		tempDirs.push(baseDir);
		const controlDbPath = getControlDbPath(baseDir);
		const sessionPath = join(baseDir, "current.jsonl");
		writeFileSync(
			sessionPath,
			`${JSON.stringify({ type: "session", id: "current", timestamp: "2026-07-11T00:00:00.000Z", cwd: baseDir })}\n`,
		);
		writeSessionMetadata(controlDbPath, {
			sessionPath,
			id: "current",
			cwd: baseDir,
			createdAt: "2026-07-11T00:00:00.000Z",
			modifiedAt: "2026-07-11T00:00:00.000Z",
			messageCount: 1,
			firstMessage: "hello",
			allMessagesText: "hello",
		});
		let command: RegisteredCommand | undefined;
		const pi = {
			registerCommand(_name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
				command = {
					...options,
					name: "archive",
					sourceInfo: { path: "<test>", source: "test", scope: "temporary", origin: "top-level" },
				};
			},
		} as unknown as ExtensionAPI;
		sessionArchiveExtension(pi);
		const notify = vi.fn();
		let activeSessionPath = sessionPath;
		let plainSessionExistedDuringTransition = false;
		await command!.handler("", {
			controlDbPath,
			ui: { notify },
			sessionManager: { getSessionFile: () => activeSessionPath },
			newSession: async (options: NewSessionOptions) => {
				plainSessionExistedDuringTransition = existsSync(sessionPath);
				activeSessionPath = join(baseDir, "next.jsonl");
				await options?.withSession?.({ ui: { notify } } as unknown as ReplacedSessionContext);
				return { cancelled: false };
			},
		} as unknown as ExtensionCommandContext);

		const archivedPath = `${sessionPath}.zst`;
		expect(plainSessionExistedDuringTransition).toBe(true);
		expect(activeSessionPath).toBe(join(baseDir, "next.jsonl"));
		expect(readSessionMetadata(controlDbPath, sessionPath)).toBeUndefined();
		expect(readSessionMetadata(controlDbPath, archivedPath)?.isArchived).toBe(true);
		expect(notify).toHaveBeenCalledWith("Archived current session.", "info");
	});

	it("stores archived sessions as zstd and restores them when resumed", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-session-archive-zstd-"));
		tempDirs.push(baseDir);
		const controlDbPath = getControlDbPath(baseDir);
		const sessionPath = join(baseDir, "current.jsonl");
		writeFileSync(
			sessionPath,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "current",
					timestamp: "2026-09-02T00:00:00.000Z",
					cwd: baseDir,
				}),
				JSON.stringify({
					type: "message",
					id: "user-message",
					parentId: null,
					timestamp: "2026-09-02T00:00:01.000Z",
					message: { role: "user", content: "resume me", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		writeSessionMetadata(controlDbPath, {
			sessionPath,
			id: "current",
			cwd: baseDir,
			createdAt: "2026-09-02T00:00:00.000Z",
			modifiedAt: "2026-09-02T00:00:01.000Z",
			messageCount: 1,
			firstMessage: "resume me",
			allMessagesText: "resume me",
		});

		let command: RegisteredCommand | undefined;
		const pi = {
			registerCommand(_name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
				command = {
					...options,
					name: "archive",
					sourceInfo: { path: "<test>", source: "test", scope: "temporary", origin: "top-level" },
				};
			},
		} as unknown as ExtensionAPI;
		sessionArchiveExtension(pi);
		await command!.handler("", {
			controlDbPath,
			ui: { notify: vi.fn() },
			sessionManager: { getSessionFile: () => sessionPath },
			newSession: async (options: NewSessionOptions) => {
				await options?.withSession?.({ ui: { notify: vi.fn() } } as unknown as ReplacedSessionContext);
				return { cancelled: false };
			},
		} as unknown as ExtensionCommandContext);

		const archivedPath = `${sessionPath}.zst`;
		expect(existsSync(sessionPath)).toBe(false);
		expect(existsSync(archivedPath)).toBe(true);
		expect(readSessionMetadata(controlDbPath, archivedPath)?.isArchived).toBe(true);

		expect(() => SessionManager.open(archivedPath, baseDir)).toThrow("Archived session requires a control database");
		expect(restoreArchivedSession(controlDbPath, archivedPath)).toBe(sessionPath);
		const resumed = SessionManager.open(sessionPath, baseDir);
		expect(resumed.getSessionFile()).toBe(sessionPath);
		expect(resumed.getEntries()).toMatchObject([
			{ type: "message", message: { content: "resume me", role: "user" } },
		]);
		expect(existsSync(sessionPath)).toBe(true);
		expect(existsSync(archivedPath)).toBe(false);
		expect(readSessionMetadata(controlDbPath, archivedPath)).toBeUndefined();
		expect(readSessionMetadata(controlDbPath, sessionPath)?.isArchived).toBe(false);
	});

	it("restores the archived file when archive metadata persistence fails", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-session-archive-rollback-"));
		tempDirs.push(baseDir);
		const sessionPath = join(baseDir, "current.jsonl");
		writeFileSync(
			sessionPath,
			`${JSON.stringify({ type: "session", id: "current", timestamp: "2026-09-02T00:00:00.000Z", cwd: baseDir })}\n`,
		);

		expect(() => archivePersistedSession(baseDir, sessionPath)).toThrow();
		expect(existsSync(sessionPath)).toBe(true);
		expect(existsSync(`${sessionPath}.zst`)).toBe(false);
	});

	it("restores the archived storage when resume metadata persistence fails", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-session-restore-rollback-"));
		tempDirs.push(baseDir);
		const controlDbPath = getControlDbPath(baseDir);
		const sessionPath = join(baseDir, "current.jsonl");
		writeFileSync(
			sessionPath,
			`${JSON.stringify({ type: "session", id: "current", timestamp: "2026-09-02T00:00:00.000Z", cwd: baseDir })}\n`,
		);
		writeSessionMetadata(controlDbPath, {
			sessionPath,
			id: "current",
			cwd: baseDir,
			createdAt: "2026-09-02T00:00:00.000Z",
			modifiedAt: "2026-09-02T00:00:00.000Z",
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		});
		const archivedPath = archivePersistedSession(controlDbPath, sessionPath);

		expect(() => restoreArchivedSession(baseDir, archivedPath)).toThrow();
		expect(existsSync(sessionPath)).toBe(false);
		expect(existsSync(archivedPath)).toBe(true);
	});
});
