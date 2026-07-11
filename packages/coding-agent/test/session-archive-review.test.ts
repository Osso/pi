import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveCompletedRecentSessions, isSessionComplete } from "../src/core/session-archive.ts";
import { getControlDbPath, listArchivedSessionMetadata, writeSessionMetadata } from "../src/core/session-control-db.ts";
import type { SessionInfo, SessionManager } from "../src/core/session-manager.ts";

describe("session archive review", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("archives clear completions while leaving incomplete sessions alone", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "pi-session-archive-review-"));
		tempDirs.push(baseDir);
		const controlDbPath = getControlDbPath(baseDir);
		const makeSession = (id: string, modified: string): SessionInfo => ({
			path: join(baseDir, `${id}.jsonl`),
			id,
			cwd: baseDir,
			created: new Date(modified),
			modified: new Date(modified),
			messageCount: 2,
			firstMessage: "prompt",
			allMessagesText: "prompt response",
		});
		const complete = makeSession("complete", "2026-07-10T00:00:00.000Z");
		const incomplete = makeSession("incomplete", "2026-07-10T00:00:00.000Z");
		for (const session of [complete, incomplete]) {
			writeSessionMetadata(controlDbPath, {
				sessionPath: session.path,
				id: session.id,
				cwd: session.cwd,
				createdAt: session.created.toISOString(),
				modifiedAt: session.modified.toISOString(),
				messageCount: session.messageCount,
				firstMessage: session.firstMessage,
				allMessagesText: session.allMessagesText,
			});
		}

		const result = await archiveCompletedRecentSessions(controlDbPath, {
			now: new Date("2026-07-11T00:00:00.000Z"),
			listSessions: async () => [complete, incomplete],
			openSession: (path) =>
				({
					getEntries: () =>
						[
							{
								type: "message",
								id: path,
								parentId: null,
								timestamp: "2026-07-10T00:00:00.000Z",
								message:
									path === complete.path
										? { role: "assistant", content: "Implemented. Tests pass." }
										: { role: "user", content: "Still broken" },
							},
						] as never,
				}) as unknown as SessionManager,
		});

		expect(result.archived).toBe(1);
		expect(result.skippedIncomplete).toBe(1);
		expect(listArchivedSessionMetadata(controlDbPath).map((session) => session.sessionPath)).toEqual([complete.path]);
	});

	it("accepts a recent conversation ending in a final assistant response", () => {
		expect(
			isSessionComplete([
				{ role: "user", content: "Fix the bug" },
				{ role: "assistant", content: "Implemented the fix. Tests pass." },
			]),
		).toBe(true);
	});

	it("rejects sessions ending with a user message", () => {
		expect(
			isSessionComplete([
				{ role: "assistant", content: "What should I inspect next?" },
				{ role: "user", content: "The deployment is still broken" },
			]),
		).toBe(false);
	});

	it("rejects assistant messages that clearly indicate unfinished work", () => {
		expect(isSessionComplete([{ role: "assistant", content: "Checking the deployment now." }])).toBe(false);
	});
});
