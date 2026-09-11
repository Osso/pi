import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionArchiveExtension from "../extensions/session-archive/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { archivePersistedSession, restoreArchivedSession } from "../src/core/session-archive-storage.ts";
import {
	archiveSession,
	getControlDbPath,
	readSessionMetadata,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";

type NewSessionOptions = NonNullable<Parameters<NonNullable<ExtensionCommandContext["newSession"]>>[0]>;
type ReplacedSessionContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

describe("session archive extension", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function unarchiveFixture() {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-unarchive-command-"));
		tempDirs.push(baseDir);
		const controlDbPath = getControlDbPath(baseDir);
		const manager = SessionManager.create(baseDir, baseDir);
		manager.appendMessage({ role: "user", content: "keep this transcript", timestamp: 1 });
		const sessionPath = manager.getSessionFile()!;
		writeSessionMetadata(controlDbPath, {
			sessionPath,
			id: manager.getSessionId(),
			cwd: baseDir,
			createdAt: "2026-09-11T00:00:00.000Z",
			modifiedAt: "2026-09-11T00:00:00.000Z",
			messageCount: 1,
			firstMessage: "keep this transcript",
			allMessagesText: "keep this transcript",
		});
		let command: RegisteredCommand | undefined;
		sessionArchiveExtension({
			registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
				if (name === "unarchive")
					command = {
						...options,
						name,
						sourceInfo: { path: "<test>", source: "test", scope: "temporary", origin: "top-level" },
					};
			},
		} as unknown as ExtensionAPI);
		const notify = vi.fn();
		const ctx = { controlDbPath, sessionManager: manager, ui: { notify } } as unknown as ExtensionCommandContext;
		return { command, ctx, notify, controlDbPath, sessionPath, manager };
	}

	it("unarchives only the current session without replacing its manager or transcript", async () => {
		const f = unarchiveFixture();
		const other = unarchiveFixture();
		archiveSession(f.controlDbPath, f.sessionPath);
		writeSessionMetadata(f.controlDbPath, readSessionMetadata(other.controlDbPath, other.sessionPath)!);
		archiveSession(f.controlDbPath, other.sessionPath);
		const before = f.manager.getEntries();
		expect(f.command).toBeDefined();
		await f.command!.handler("  ", f.ctx);
		expect(readSessionMetadata(f.controlDbPath, f.sessionPath)?.isArchived).toBe(false);
		expect(readSessionMetadata(f.controlDbPath, other.sessionPath)?.isArchived).toBe(true);
		expect(f.manager.getSessionFile()).toBe(f.sessionPath);
		expect(f.manager.getEntries()).toEqual(before);
		expect(f.notify).toHaveBeenCalledWith("Unarchived current session.", "info");
	});

	it("reports an already-unarchived session without changing metadata", async () => {
		const f = unarchiveFixture();
		const before = readSessionMetadata(f.controlDbPath, f.sessionPath);
		expect(f.command).toBeDefined();
		await f.command!.handler("", f.ctx);
		expect(readSessionMetadata(f.controlDbPath, f.sessionPath)).toEqual(before);
		expect(f.notify).toHaveBeenCalledWith("Current session is already unarchived.", "info");
	});

	it.each([
		["other-session", "valid", "Usage: /unarchive", "warning"],
		["", "no-db", "Session unarchive requires a control database.", "error"],
		["", "no-session", "The current session is not persisted.", "warning"],
	] as const)("rejects %s with %s", async (args, state, message, level) => {
		const f = unarchiveFixture();
		archiveSession(f.controlDbPath, f.sessionPath);
		const ctx = {
			...f.ctx,
			controlDbPath: state === "no-db" ? undefined : f.controlDbPath,
			sessionManager: state === "no-session" ? { getSessionFile: () => undefined } : f.manager,
		} as unknown as ExtensionCommandContext;
		expect(f.command).toBeDefined();
		await f.command!.handler(args, ctx);
		expect(readSessionMetadata(f.controlDbPath, f.sessionPath)?.isArchived).toBe(true);
		expect(f.notify).toHaveBeenCalledWith(message, level);
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
