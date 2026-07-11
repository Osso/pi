import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionArchiveExtension from "../extensions/session-archive/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { getControlDbPath, readSessionMetadata, writeSessionMetadata } from "../src/core/session-control-db.ts";

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
		await command!.handler("", {
			controlDbPath,
			ui: { notify },
			sessionManager: { getSessionFile: () => sessionPath },
		} as unknown as ExtensionCommandContext);

		expect(readSessionMetadata(controlDbPath, sessionPath)?.isArchived).toBe(true);
		expect(notify).toHaveBeenCalledWith("Archived current session.", "info");
	});
});
