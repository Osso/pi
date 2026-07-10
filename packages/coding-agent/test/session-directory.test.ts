import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getControlDbPath,
	listRuntimeMailboxMessages,
	readSessionHealth,
	registerRuntimeMailboxListener,
	writeSessionGoal,
	writeSessionHealth,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { broadcastToSessions, listSessions } from "../src/core/session-directory.ts";
import { emptySessionHealth } from "../src/core/session-health.ts";

type SessionOverrides = {
	name?: string;
	cwd?: string;
	goal?: string;
	sessionPath?: string;
	modifiedAt?: string;
};

describe("session directory", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-directory-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	function writeSession(id: string, overrides?: SessionOverrides): void {
		const sessionPath = overrides?.sessionPath ?? `/sessions/${id}.jsonl`;
		writeSessionMetadata(controlDbPath, {
			sessionPath,
			id,
			cwd: overrides?.cwd ?? `/repo/${id}`,
			name: overrides?.name,
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: overrides?.modifiedAt ?? "2026-01-01T00:10:00.000Z",
			messageCount: 1,
			firstMessage: "hello",
			allMessagesText: "hello",
		});
		if (overrides?.goal) {
			writeSessionGoal(controlDbPath, sessionPath, JSON.stringify({ objective: overrides.goal }));
		}
	}

	it("lists sessions with purpose metadata and live pid health", () => {
		writeSession("session-a", { name: "Alpha", goal: "ship feature", cwd: "/repo/a" });
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-a" }, process.pid);

		const sessions = listSessions(controlDbPath, {
			signalProcess: () => {},
			now: () => new Date("2026-01-01T00:11:00.000Z"),
		});

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			sessionId: "session-a",
			name: "Alpha",
			goal: "ship feature",
			cwd: "/repo/a",
			pid: process.pid,
			checkStatus: "ok",
			eligibleToReceive: true,
			agentGeneration: 1,
		});
	});

	it("keeps sticky dead sessions skipped until generation advances", () => {
		writeSession("session-dead");
		writeSessionHealth(controlDbPath, {
			...emptySessionHealth("session-dead", "2026-01-01T00:00:00.000Z"),
			agentGeneration: 1,
			pid: 999_999,
			checkStatus: "dead",
			checkedGeneration: 1,
			lastCheckedAt: "2026-01-01T00:01:00.000Z",
		});

		const first = listSessions(controlDbPath, {
			signalProcess: () => {
				throw new Error("should not recheck sticky dead");
			},
		});
		expect(first[0]).toMatchObject({
			sessionId: "session-dead",
			checkStatus: "dead",
			eligibleToReceive: false,
		});

		// New agent process re-registers under a still-dead pid first, advancing generation.
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-dead" }, process.pid);
		const afterRestart = listSessions(controlDbPath, {
			signalProcess: () => {},
		});
		expect(afterRestart[0]?.checkStatus).toBe("ok");
		expect(afterRestart[0]?.eligibleToReceive).toBe(true);
		expect(afterRestart[0]?.agentGeneration).toBe(2);
	});

	it("broadcasts once to a session with multiple metadata paths", () => {
		writeSession("session-live", {
			sessionPath: "/sessions/session-live-old.jsonl",
			modifiedAt: "2026-01-01T00:10:00.000Z",
		});
		writeSession("session-live", {
			sessionPath: "/sessions/session-live-new.jsonl",
			modifiedAt: "2026-01-01T00:11:00.000Z",
		});
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-live" }, process.pid);

		const results = broadcastToSessions(
			controlDbPath,
			{
				message: "please restart",
				senderSessionId: "sender-session",
				senderSessionPath: "/sessions/sender.jsonl",
				senderAgentId: null,
			},
			{ signalProcess: () => {} },
		);

		expect(results).toEqual([
			expect.objectContaining({ sessionId: "session-live", outcome: "sent", checkStatus: "ok" }),
		]);
		const messages = listRuntimeMailboxMessages(controlDbPath);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.recipient).toEqual({ agentId: null, sessionId: "session-live" });
	});

	it("matches broadcast filters against the newest metadata entry for duplicate sessions", () => {
		writeSession("session-live", {
			cwd: "/repo/old",
			sessionPath: "/sessions/session-live-old.jsonl",
			modifiedAt: "2026-01-01T00:10:00.000Z",
		});
		writeSession("session-live", {
			cwd: "/repo/new",
			sessionPath: "/sessions/session-live-new.jsonl",
			modifiedAt: "2026-01-01T00:11:00.000Z",
		});
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-live" }, process.pid);

		const results = broadcastToSessions(
			controlDbPath,
			{
				message: "please restart",
				filters: { cwd: "/repo/old" },
				senderSessionId: "sender-session",
				senderSessionPath: "/sessions/sender.jsonl",
				senderAgentId: null,
			},
			{ signalProcess: () => {} },
		);

		expect(results).toEqual([expect.objectContaining({ sessionId: "session-live", outcome: "skipped_filter" })]);
		expect(listRuntimeMailboxMessages(controlDbPath)).toHaveLength(0);
	});

	it("broadcasts only to eligible matching sessions and returns per-target outcomes", () => {
		writeSession("session-live", { name: "Live", cwd: "/repo/live" });
		writeSession("session-dead", { name: "Dead", cwd: "/repo/dead" });
		writeSession("session-filtered", { name: "Other", cwd: "/repo/other" });

		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-live" }, process.pid);
		writeSessionHealth(controlDbPath, {
			...emptySessionHealth("session-dead", "2026-01-01T00:00:00.000Z"),
			agentGeneration: 1,
			pid: 999_999,
			checkStatus: "dead",
			checkedGeneration: 1,
			lastCheckedAt: "2026-01-01T00:01:00.000Z",
		});
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-filtered" }, process.pid);

		const results = broadcastToSessions(
			controlDbPath,
			{
				message: "please restart",
				filters: { sessionIds: ["session-live", "session-dead"] },
				senderSessionId: "sender-session",
				senderSessionPath: "/sessions/sender.jsonl",
				senderAgentId: null,
			},
			{
				signalProcess: () => {},
			},
		);

		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sessionId: "session-live", outcome: "sent", checkStatus: "ok" }),
				expect.objectContaining({ sessionId: "session-dead", outcome: "skipped_dead", checkStatus: "dead" }),
				expect.objectContaining({ sessionId: "session-filtered", outcome: "skipped_filter" }),
			]),
		);

		const messages = listRuntimeMailboxMessages(controlDbPath);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.recipient).toEqual({ agentId: null, sessionId: "session-live" });
		expect(readSessionHealth(controlDbPath, "session-live")?.checkStatus).toBe("ok");
	});
});
