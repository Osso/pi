import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepAbandonedEmptySessions } from "../src/core/empty-session-cleanup.ts";
import {
	getControlDbPath,
	readSessionMetadata,
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
		allMessagesText: "",
	});
}

describe("empty session cleanup", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
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
