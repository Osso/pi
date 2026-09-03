import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	getControlDbPath,
	readRuntimeMailboxListener,
	readSessionMetadata,
	writeSessionMetadata,
} from "../../src/core/session-control-db.ts";
import { openSupervisorSession } from "../../src/supervisor/main.ts";
import { withHeadlessPi } from "./headless-pi.ts";

function writeResidentTranscript(path: string, id: string, cwd: string, content: string): void {
	writeFileSync(
		path,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-03T00:00:00.000Z", cwd })}\n${JSON.stringify(
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: "2026-09-03T00:00:01.000Z",
				message: { role: "user", content, timestamp: 1 },
			},
		)}\n`,
	);
}

describe("resident session recovery", () => {
	it("preserves a live child Supervisor transcript while replacing stale resident history", async () => {
		await withHeadlessPi(async (runtime) => {
			const controlDbPath = getControlDbPath(runtime.paths.agentDir);
			const sessionDir = join(runtime.paths.agentDir, "supervisor-sessions");
			mkdirSync(sessionDir);
			const activePath = join(sessionDir, "2026-09-01T00-00-00-000Z_supervisor.jsonl");
			const stalePath = join(sessionDir, "2026-09-02T00-00-00-000Z_supervisor.jsonl");
			const missingPath = join(sessionDir, "2026-09-03T00-00-00-000Z_supervisor.jsonl");
			writeResidentTranscript(activePath, "supervisor", runtime.paths.workspaceDir, "live child content");
			const child = await runtime.startSharedSession({ sessionFile: activePath });
			try {
				await vi.waitFor(() =>
					expect(
						readRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "supervisor" })?.sessionPath,
					).toBe(activePath),
				);
				writeSessionMetadata(controlDbPath, {
					sessionPath: activePath,
					id: "supervisor",
					cwd: runtime.paths.workspaceDir,
					name: "Live transcript",
					createdAt: "2026-09-01T00:00:00.000Z",
					modifiedAt: "2026-09-01T00:00:00.000Z",
					messageCount: 1,
					firstMessage: "live child content",
					allMessagesText: "live child content",
				});
				writeResidentTranscript(stalePath, "supervisor", runtime.paths.workspaceDir, "stale content");
				writeSessionMetadata(controlDbPath, {
					sessionPath: stalePath,
					id: "supervisor",
					cwd: runtime.paths.workspaceDir,
					name: "Stale transcript",
					createdAt: "2026-09-02T00:00:00.000Z",
					modifiedAt: "2026-09-02T00:00:00.000Z",
					messageCount: 1,
					firstMessage: "stale content",
					allMessagesText: "stale content",
				});
				writeSessionMetadata(controlDbPath, {
					sessionPath: missingPath,
					id: "supervisor",
					cwd: runtime.paths.workspaceDir,
					name: "Missing transcript",
					createdAt: "2026-09-03T00:00:00.000Z",
					modifiedAt: "2026-09-03T00:00:00.000Z",
					messageCount: 1,
					firstMessage: "missing content",
					allMessagesText: "missing content",
				});

				const retained = openSupervisorSession(runtime.paths.agentDir, runtime.paths.workspaceDir, controlDbPath);

				expect(retained.getSessionFile()).toBe(activePath);
				expect(existsSync(activePath)).toBe(true);
				expect(readFileSync(activePath, "utf8")).toContain("live child content");
				expect(readSessionMetadata(controlDbPath, activePath)).toMatchObject({ name: "Live transcript" });
				expect(existsSync(stalePath)).toBe(false);
				expect(readSessionMetadata(controlDbPath, stalePath)).toBeUndefined();
				expect(readSessionMetadata(controlDbPath, missingPath)).toBeUndefined();
				expect(
					readRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "supervisor" })?.sessionPath,
				).toBe(activePath);
			} finally {
				await child.dispose();
			}
		});
	});
});
