import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepAbandonedEmptySessions } from "../src/core/empty-session-cleanup.ts";
import {
	archiveSession,
	getControlDbPath,
	listEmptyMainSessionCandidates,
	readSessionMetadata,
	unarchiveSession,
	writeSessionHealth,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { emptySessionHealth } from "../src/core/session-health.ts";

function writeEmptySession(controlDbPath: string, sessionPath: string, id: string): void {
	writeSessionMetadata(controlDbPath, {
		sessionPath,
		id,
		cwd: "/tmp",
		createdAt: "2026-09-03T00:00:00.000Z",
		modifiedAt: "2026-09-03T00:00:00.000Z",
		messageCount: 0,
		firstMessage: "(no messages)",
	});
}

describe("empty session cleanup", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns only active empty main-session identities without unrelated message text", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-empty-session-candidates-"));
		tempDirs.push(agentDir);
		const controlDbPath = getControlDbPath(agentDir);
		for (const [id, overrides] of [
			["empty", {}],
			["nonempty", { messageCount: 1 }],
			["subagent", { isSubagent: true }],
			["archived", { archivedAt: "2026-09-03T00:00:00.000Z" }],
		] as const) {
			writeSessionMetadata(controlDbPath, {
				sessionPath: join(agentDir, `${id}.jsonl`),
				id,
				cwd: agentDir,
				createdAt: "2026-09-03T00:00:00.000Z",
				modifiedAt: "2026-09-03T00:00:00.000Z",
				messageCount: 0,
				firstMessage: "(no messages)",
				...overrides,
			});
		}

		expect(listEmptyMainSessionCandidates(controlDbPath)).toEqual([
			{ id: "empty", sessionPath: join(agentDir, "empty.jsonl") },
		]);
		expect(sweepAbandonedEmptySessions(controlDbPath)).toBe(1);
		expect(readSessionMetadata(controlDbPath, join(agentDir, "empty.jsonl"))).toBeUndefined();
		for (const id of ["nonempty", "subagent", "archived"]) {
			expect(readSessionMetadata(controlDbPath, join(agentDir, `${id}.jsonl`))).toBeDefined();
		}
	});

	it("tracks empty main-session candidates across message, child, and archive transitions", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-empty-session-transitions-"));
		tempDirs.push(agentDir);
		const controlDbPath = getControlDbPath(agentDir);
		const sessionPath = join(agentDir, "candidate.jsonl");
		const base = {
			sessionPath,
			id: "candidate",
			cwd: agentDir,
			createdAt: "2026-09-03T00:00:00.000Z",
			modifiedAt: "2026-09-03T00:00:00.000Z",
			firstMessage: "(no messages)",
		};
		const candidates = () => listEmptyMainSessionCandidates(controlDbPath);
		const expected = [{ id: "candidate", sessionPath }];

		writeSessionMetadata(controlDbPath, { ...base, messageCount: 0 });
		expect(candidates()).toEqual(expected);

		writeSessionMetadata(controlDbPath, { ...base, messageCount: 1 });
		expect(candidates()).toEqual([]);

		writeSessionMetadata(controlDbPath, { ...base, messageCount: 0, isSubagent: true });
		expect(candidates()).toEqual([]);

		archiveSession(controlDbPath, sessionPath);
		expect(candidates()).toEqual([]);

		writeSessionMetadata(controlDbPath, { ...base, messageCount: 0, isSubagent: false });
		expect(candidates()).toEqual([]);

		unarchiveSession(controlDbPath, sessionPath);
		expect(candidates()).toEqual(expected);
	});

	it("removes only dead fileless empty sessions during startup sweep", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-empty-session-cleanup-"));
		tempDirs.push(agentDir);
		const controlDbPath = getControlDbPath(agentDir);
		const abandonedPath = join(agentDir, "abandoned.jsonl");
		const livePath = join(agentDir, "live.jsonl");
		const recoveryPath = join(agentDir, "recovery.jsonl");
		const residentPath = join(agentDir, "supervisor-sessions", "supervisor.jsonl");

		writeEmptySession(controlDbPath, abandonedPath, "abandoned");
		writeEmptySession(controlDbPath, livePath, "live");
		writeEmptySession(controlDbPath, recoveryPath, "recovery");
		writeEmptySession(controlDbPath, residentPath, "supervisor");
		writeSessionHealth(controlDbPath, {
			...emptySessionHealth("live"),
			pid: process.pid,
			checkStatus: "ok",
		});
		writeFileSync(recoveryPath, '{"type":"session","id":"recovery"}\n');

		expect(sweepAbandonedEmptySessions(controlDbPath)).toBe(1);
		expect(readSessionMetadata(controlDbPath, abandonedPath)).toBeUndefined();
		expect(readSessionMetadata(controlDbPath, livePath)?.messageCount).toBe(0);
		expect(readSessionMetadata(controlDbPath, recoveryPath)?.messageCount).toBe(0);
		expect(readSessionMetadata(controlDbPath, residentPath)?.messageCount).toBe(0);
		expect(existsSync(recoveryPath)).toBe(true);
	});
});
