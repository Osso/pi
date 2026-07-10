import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readArchitectSnapshot } from "../src/architect/observer.ts";
import {
	getControlDbPath,
	listRuntimeMailboxListeners,
	listRuntimeMailboxMessages,
	readMultiAgentState,
	readSessionHealth,
	registerRuntimeMailboxListener,
	upsertMultiAgentAgent,
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

		const sessions = listSessions(controlDbPath);

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

		const first = listSessions(controlDbPath);
		expect(first[0]).toMatchObject({
			sessionId: "session-dead",
			checkStatus: "dead",
			eligibleToReceive: false,
		});

		// New agent process re-registers under a still-dead pid first, advancing generation.
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-dead" }, process.pid);
		const afterRestart = listSessions(controlDbPath);
		expect(afterRestart[0]?.checkStatus).toBe("ok");
		expect(afterRestart[0]?.eligibleToReceive).toBe(true);
		expect(afterRestart[0]?.agentGeneration).toBe(2);
	});

	it("does not revive an unbound historical session from a reused live pid", () => {
		writeSession("session-historical");
		writeSessionHealth(controlDbPath, {
			...emptySessionHealth("session-historical", "2026-01-01T00:00:00.000Z"),
			agentGeneration: 1,
			pid: process.pid,
			lastActiveAt: "2026-01-01T00:00:00.000Z",
			lastCheckedAt: "2026-01-01T00:00:00.000Z",
			checkStatus: "ok",
			checkedGeneration: 1,
		});
		const sessions = listSessions(controlDbPath, {
			now: () => new Date("2026-01-01T00:11:00.000Z"),
		});

		expect(sessions).toEqual([
			expect.objectContaining({
				sessionId: "session-historical",
				pid: null,
				status: "ended",
				checkStatus: "dead",
				eligibleToReceive: false,
			}),
		]);
	});

	it("expires a stale binding when its pid no longer belongs to a Pi runtime", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			writeSession("session-stale");
			registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-stale" }, process.pid);
			vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
			const sessions = listSessions(controlDbPath, { isRuntimeProcessAlive: () => false });

			expect(sessions).toEqual([
				expect.objectContaining({ sessionId: "session-stale", pid: null, status: "ended", checkStatus: "dead" }),
			]);
			expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects a future-dated heartbeat when its pid is not a Pi runtime", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T01:00:00.000Z"));
			writeSession("session-future");
			registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-future" }, process.pid);
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

			const sessions = listSessions(controlDbPath, { isRuntimeProcessAlive: () => false });

			expect(sessions).toEqual([
				expect.objectContaining({
					sessionId: "session-future",
					pid: null,
					status: "ended",
					checkStatus: "dead",
					eligibleToReceive: false,
				}),
			]);
			expect(listRuntimeMailboxListeners(controlDbPath)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not abort a stale supervisor store while its process is still alive", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			writeSession("session-stale-live");
			registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-stale-live" }, process.pid);
			upsertMultiAgentAgent(controlDbPath, "/sessions/session-stale-live.jsonl", "spawned", {
				id: "spawned",
				lifecycle: "running",
				revision: 1,
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
			vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));

			const sessions = listSessions(controlDbPath);

			expect(sessions).toEqual([
				expect.objectContaining({
					sessionId: "session-stale-live",
					pid: process.pid,
					status: "ended",
					checkStatus: "timeout",
					eligibleToReceive: false,
				}),
			]);
			expect(listRuntimeMailboxListeners(controlDbPath)).toHaveLength(1);
			expect(readMultiAgentState(controlDbPath, "/sessions/session-stale-live.jsonl")?.agents).toMatchObject([
				{ id: "spawned", lifecycle: "running", revision: 1 },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts spawned ghosts after retiring stale supervisor listeners without touching live, attached, or queued rows", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			writeSession("session-stale");
			writeSession("session-live");
			registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-stale" }, process.pid);
			upsertMultiAgentAgent(controlDbPath, "/sessions/session-stale.jsonl", "spawned", {
				id: "spawned",
				lifecycle: "running",
				revision: 1,
				updatedAt: "2026-01-01T00:00:00.000Z",
				worker: { adapter: "runtime", handleId: "old-job" },
			});
			upsertMultiAgentAgent(controlDbPath, "/sessions/session-stale.jsonl", "attached", {
				id: "attached",
				origin: "attached",
				lifecycle: "waiting_for_input",
				revision: 1,
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
			upsertMultiAgentAgent(controlDbPath, "/sessions/session-stale.jsonl", "queued", {
				id: "queued",
				origin: "spawned",
				lifecycle: "queued",
				revision: 1,
				updatedAt: "2026-01-01T00:00:00.000Z",
			});
			vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
			registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-live" }, process.pid + 1);
			upsertMultiAgentAgent(controlDbPath, "/sessions/session-live.jsonl", "live", {
				id: "live",
				lifecycle: "running",
				revision: 1,
				updatedAt: "2026-01-01T00:00:00.000Z",
			});

			listSessions(controlDbPath, { isRuntimeProcessAlive: () => false });

			expect(readSessionHealth(controlDbPath, "session-stale")?.pid).toBeNull();
			expect(readMultiAgentState(controlDbPath, "/sessions/session-stale.jsonl")?.agents).toMatchObject([
				{
					id: "spawned",
					lifecycle: "aborted",
					revision: 2,
					error: { code: "supervisor_restarted" },
				},
				{ id: "attached", lifecycle: "waiting_for_input", revision: 1 },
				{ id: "queued", lifecycle: "queued", revision: 1 },
			]);
			expect(readMultiAgentState(controlDbPath, "/sessions/session-live.jsonl")?.agents).toMatchObject([
				{ id: "live", lifecycle: "running", revision: 1 },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("excludes ended sessions when includeEnded is false", () => {
		writeSession("session-ended");
		writeSessionHealth(controlDbPath, {
			...emptySessionHealth("session-ended", "2026-01-01T00:00:00.000Z"),
			agentGeneration: 1,
			checkStatus: "dead",
			checkedGeneration: 1,
			lastCheckedAt: "2026-01-01T00:01:00.000Z",
		});

		expect(listSessions(controlDbPath, { includeEnded: false })).toEqual([]);
	});

	it("keeps global inventory and Architect snapshots on the current main-session binding", () => {
		writeSession("session-historical", { cwd: "/repo/historical" });
		writeSession("session-current", { cwd: "/repo/current" });
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-historical" }, process.pid);
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-current" }, process.pid);

		const sessions = listSessions(controlDbPath, { includeEnded: false });
		const snapshot = readArchitectSnapshot(controlDbPath, 0);

		expect(sessions.map((session) => session.sessionId)).toEqual(["session-current"]);
		expect(snapshot.sessions.map((session) => session.id)).toEqual(["session-current"]);
		expect(readSessionHealth(controlDbPath, "session-historical")).toMatchObject({
			pid: null,
			checkStatus: "dead",
		});
	});

	it("uses session path as the deterministic tie-break for duplicate metadata", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
			writeSession("session-live", {
				cwd: "/repo/historical",
				sessionPath: "/sessions/a-historical.jsonl",
				modifiedAt: "2026-01-01T00:11:00.000Z",
			});
			writeSession("session-live", {
				cwd: "/repo/current",
				sessionPath: "/sessions/z-current.jsonl",
				modifiedAt: "2026-01-01T00:11:00.000Z",
			});
			registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-live" }, process.pid);

			const sessions = listSessions(controlDbPath, { includeEnded: false });

			expect(sessions).toEqual([
				expect.objectContaining({
					sessionId: "session-live",
					sessionPath: "/sessions/z-current.jsonl",
					cwd: "/repo/current",
				}),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts spawned ghosts in historical duplicate paths without touching the current path", () => {
		writeSession("session-live", {
			sessionPath: "/sessions/session-live-old.jsonl",
			modifiedAt: "2026-01-01T00:10:00.000Z",
		});
		writeSession("session-live", {
			sessionPath: "/sessions/session-live-current.jsonl",
			modifiedAt: "2026-01-01T00:11:00.000Z",
		});
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "session-live" },
			process.pid,
			"/sessions/session-live-current.jsonl",
		);
		upsertMultiAgentAgent(controlDbPath, "/sessions/session-live-old.jsonl", "historical", {
			id: "historical",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:10:00.000Z",
		});
		upsertMultiAgentAgent(controlDbPath, "/sessions/session-live-current.jsonl", "current", {
			id: "current",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:11:00.000Z",
		});

		listSessions(controlDbPath);

		expect(readMultiAgentState(controlDbPath, "/sessions/session-live-old.jsonl")?.agents).toMatchObject([
			{ id: "historical", lifecycle: "aborted", revision: 2, error: { code: "supervisor_restarted" } },
		]);
		expect(readMultiAgentState(controlDbPath, "/sessions/session-live-current.jsonl")?.agents).toMatchObject([
			{ id: "current", lifecycle: "running", revision: 1 },
		]);
	});

	it("uses another live listener's exact path instead of duplicate metadata ordering", () => {
		const liveSessionPath = "/sessions/session-live-actual.jsonl";
		const historicalSessionPath = "/sessions/session-live-newer-metadata.jsonl";
		writeSession("session-live", {
			sessionPath: liveSessionPath,
			modifiedAt: "2026-01-01T00:10:00.000Z",
		});
		writeSession("session-live", {
			sessionPath: historicalSessionPath,
			modifiedAt: "2026-01-01T00:11:00.000Z",
		});
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "session-live" },
			process.pid,
			liveSessionPath,
		);
		upsertMultiAgentAgent(controlDbPath, liveSessionPath, "current", {
			id: "current",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:10:00.000Z",
		});
		upsertMultiAgentAgent(controlDbPath, historicalSessionPath, "historical", {
			id: "historical",
			lifecycle: "running",
			revision: 1,
			updatedAt: "2026-01-01T00:11:00.000Z",
		});

		listSessions(controlDbPath);

		expect(readMultiAgentState(controlDbPath, liveSessionPath)?.agents).toMatchObject([
			{ id: "current", lifecycle: "running", revision: 1 },
		]);
		expect(readMultiAgentState(controlDbPath, historicalSessionPath)?.agents).toMatchObject([
			{ id: "historical", lifecycle: "aborted", revision: 2, error: { code: "supervisor_restarted" } },
		]);
	});

	it("broadcasts only to the newest main-session listener for a shared live pid", () => {
		vi.useFakeTimers();
		try {
			writeSession("session-historical", { cwd: "/repo/historical" });
			writeSession("session-current", { cwd: "/repo/current" });
			vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
			registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-historical" }, process.pid);
			vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
			registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-current" }, process.pid);

			const sent = broadcastToSessions(controlDbPath, {
				message: "please restart",
				senderSessionId: "sender-session",
				senderSessionPath: "/sessions/sender.jsonl",
				senderAgentId: null,
			});

			expect(sent).toEqual([
				expect.objectContaining({ sessionId: "session-current", outcome: "sent", checkStatus: "ok" }),
			]);
			expect(listRuntimeMailboxMessages(controlDbPath)).toHaveLength(1);
			expect(listRuntimeMailboxMessages(controlDbPath)[0]?.recipient).toEqual({
				agentId: null,
				sessionId: "session-current",
			});

			const filtered = broadcastToSessions(controlDbPath, {
				message: "please restart again",
				filters: { sessionIds: ["session-historical"] },
				senderSessionId: "sender-session",
				senderSessionPath: "/sessions/sender.jsonl",
				senderAgentId: null,
			});

			expect(filtered).toEqual([
				expect.objectContaining({ sessionId: "session-current", outcome: "skipped_filter" }),
			]);
			expect(listRuntimeMailboxMessages(controlDbPath)).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
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

		const results = broadcastToSessions(controlDbPath, {
			message: "please restart",
			senderSessionId: "sender-session",
			senderSessionPath: "/sessions/sender.jsonl",
			senderAgentId: null,
		});

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

		const results = broadcastToSessions(controlDbPath, {
			message: "please restart",
			filters: { cwd: "/repo/old" },
			senderSessionId: "sender-session",
			senderSessionPath: "/sessions/sender.jsonl",
			senderAgentId: null,
		});

		expect(results).toEqual([expect.objectContaining({ sessionId: "session-live", outcome: "skipped_filter" })]);
		expect(listRuntimeMailboxMessages(controlDbPath)).toHaveLength(0);
	});

	it("broadcasts only to eligible matching current sessions and returns per-target outcomes", () => {
		writeSession("session-live", { name: "Live", cwd: "/repo/live" });
		writeSession("session-filtered", { name: "Other", cwd: "/repo/other" });

		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-live" }, process.pid);
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "session-filtered" }, process.pid + 1);

		const results = broadcastToSessions(controlDbPath, {
			message: "please restart",
			filters: { sessionIds: ["session-live"] },
			senderSessionId: "sender-session",
			senderSessionPath: "/sessions/sender.jsonl",
			senderAgentId: null,
		});

		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sessionId: "session-live", outcome: "sent", checkStatus: "ok" }),
				expect.objectContaining({ sessionId: "session-filtered", outcome: "skipped_filter" }),
			]),
		);

		const messages = listRuntimeMailboxMessages(controlDbPath);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.recipient).toEqual({ agentId: null, sessionId: "session-live" });
		expect(readSessionHealth(controlDbPath, "session-live")?.checkStatus).toBe("ok");
	});
});
