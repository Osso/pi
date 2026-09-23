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
			on: () => {},
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
			on: () => {},
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

	function quitCommandFixture() {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-session-quit-command-"));
		tempDirs.push(baseDir);
		const controlDbPath = getControlDbPath(baseDir);
		const writeSession = (name: string, options?: { parentSession?: string }) => {
			const manager = SessionManager.create(
				baseDir,
				baseDir,
				options ? { ...options, isSubagent: true } : undefined,
			);
			manager.setMetadataControlDbPath(controlDbPath);
			manager.appendMessage({ role: "user", content: `${name} work`, timestamp: 1 });
			manager.persistForRecovery();
			return manager.getSessionFile()!;
		};
		const sessionPath = writeSession("current");
		const childPath = writeSession("child", { parentSession: sessionPath });
		const otherPath = writeSession("other");
		const commands = new Map<string, RegisteredCommand>();
		const shutdownHandlers: Array<(event: { reason: string }) => void> = [];
		sessionArchiveExtension({
			on(event: string, handler: (event: { reason: string }) => void) {
				if (event === "session_shutdown") shutdownHandlers.push(handler);
			},
			registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
				commands.set(name, {
					...options,
					name,
					sourceInfo: { path: "<test>", source: "test", scope: "temporary", origin: "top-level" },
				});
			},
		} as unknown as ExtensionAPI);
		const notify = vi.fn();
		const confirm = vi.fn(async () => true);
		const shutdown = vi.fn();
		const ctx = {
			controlDbPath,
			sessionManager: { getSessionFile: () => sessionPath },
			shutdown,
			ui: { confirm, notify },
		} as unknown as ExtensionCommandContext;
		const teardown = (reason: string) => {
			for (const handler of shutdownHandlers) handler({ reason });
		};
		const quit = () => teardown("quit");
		return {
			childPath,
			commands,
			confirm,
			controlDbPath,
			ctx,
			notify,
			otherPath,
			quit,
			sessionPath,
			shutdown,
			teardown,
		};
	}

	it("archives the current session when quitting after /archive", async () => {
		const f = quitCommandFixture();
		await f.commands.get("archive")!.handler("", f.ctx);

		expect(f.shutdown).toHaveBeenCalledOnce();
		expect(existsSync(f.sessionPath)).toBe(true);
		f.quit();

		const archivedPath = `${f.sessionPath}.zst`;
		expect(existsSync(f.sessionPath)).toBe(false);
		expect(readSessionMetadata(f.controlDbPath, f.sessionPath)).toBeUndefined();
		expect(readSessionMetadata(f.controlDbPath, archivedPath)?.isArchived).toBe(true);
		expect(readSessionMetadata(f.controlDbPath, f.otherPath)?.isArchived).toBe(false);
	});

	it("deletes the current session and its child sessions when quitting after a confirmed /delete", async () => {
		const f = quitCommandFixture();
		await f.commands.get("delete")!.handler("", f.ctx);

		expect(f.confirm).toHaveBeenCalledOnce();
		expect(f.shutdown).toHaveBeenCalledOnce();
		f.quit();

		expect([f.sessionPath, f.childPath].map((path) => existsSync(path))).toEqual([false, false]);
		expect(readSessionMetadata(f.controlDbPath, f.sessionPath)).toBeUndefined();
		expect(readSessionMetadata(f.controlDbPath, f.childPath)).toBeUndefined();
		expect(existsSync(f.otherPath)).toBe(true);
		expect(readSessionMetadata(f.controlDbPath, f.otherPath)).toBeDefined();
	});

	it("keeps the session and pi running when /delete is declined", async () => {
		const f = quitCommandFixture();
		f.confirm.mockResolvedValueOnce(false);
		await f.commands.get("delete")!.handler("", f.ctx);
		f.quit();

		expect(f.shutdown).not.toHaveBeenCalled();
		expect([f.sessionPath, f.childPath].map((path) => existsSync(path))).toEqual([true, true]);
	});

	it("does not archive when the pending teardown is not a quit", async () => {
		const f = quitCommandFixture();
		await f.commands.get("archive")!.handler("", f.ctx);
		f.teardown("reload");
		f.quit();

		expect(existsSync(f.sessionPath)).toBe(true);
		expect(readSessionMetadata(f.controlDbPath, f.sessionPath)?.isArchived).toBe(false);
	});

	it("rejects /delete arguments without confirming or quitting", async () => {
		const f = quitCommandFixture();
		await f.commands.get("delete")!.handler("other-session", f.ctx);

		expect(f.notify).toHaveBeenCalledWith("Usage: /delete", "warning");
		expect(f.confirm).not.toHaveBeenCalled();
		expect(f.shutdown).not.toHaveBeenCalled();
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
		let onShutdown: ((event: { reason: string }) => void) | undefined;
		const pi = {
			on: (_event: string, handler: (event: { reason: string }) => void) => {
				onShutdown = handler;
			},
			registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
				if (name !== "archive") return;
				command = {
					...options,
					name,
					sourceInfo: { path: "<test>", source: "test", scope: "temporary", origin: "top-level" },
				};
			},
		} as unknown as ExtensionAPI;
		sessionArchiveExtension(pi);
		await command!.handler("", {
			controlDbPath,
			ui: { notify: vi.fn() },
			sessionManager: { getSessionFile: () => sessionPath },
			shutdown: () => onShutdown?.({ reason: "quit" }),
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
