import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ArchitectChannelMessage,
	ArchitectObserver,
	type ArchitectSessionSnapshot,
	createArchitectObservation,
	readArchitectSnapshot,
} from "../src/architect/observer.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

const session: ArchitectSessionSnapshot = {
	cwd: "/repo",
	goalJson: '{"objective":"Keep tests green"}',
	id: "main-session",
	isSubagent: false,
	name: "main",
};

describe("architect observer", () => {
	it("emits an initial snapshot", () => {
		const observation = createArchitectObservation(undefined, [session], []);

		expect(observation).toMatchObject({ reason: "session_state_changed", sessions: [session] });
	});

	it("ignores non-material session metadata changes", () => {
		const previous = createArchitectObservation(undefined, [session], []);
		if (!previous) throw new Error("expected initial observation");

		expect(createArchitectObservation(previous, [session], [])).toBeUndefined();
	});

	it("emits an observation when an active goal changes", () => {
		const previous = createArchitectObservation(undefined, [session], []);
		if (!previous) throw new Error("expected initial observation");
		const changed = { ...session, goalJson: '{"objective":"Deploy safely"}' };

		expect(createArchitectObservation(previous, [changed], [])).toMatchObject({
			reason: "session_state_changed",
			sessions: [changed],
		});
	});

	it("emits an observation for explicit main-session architect requests", () => {
		const previous = createArchitectObservation(undefined, [session], []);
		if (!previous) throw new Error("expected initial observation");
		const request: ArchitectChannelMessage = {
			body: "Architect: assess goal drift",
			id: 4,
			senderAgentId: null,
			senderSessionId: "other-main",
		};

		expect(createArchitectObservation(previous, [session], [request])).toMatchObject({
			reason: "architect_request",
			requests: [request],
		});
	});

	it("ignores subagent, Architect, and unrelated channel posts", () => {
		const previous = createArchitectObservation(undefined, [session], []);
		if (!previous) throw new Error("expected initial observation");
		const messages: ArchitectChannelMessage[] = [
			{ body: "Architect: ignore this", id: 5, senderAgentId: "agent_1", senderSessionId: "child" },
			{ body: "Architect: this is already known", id: 6, senderAgentId: null, senderSessionId: "architect" },
			{ body: "Re architect blocker: already confirmed", id: 7, senderAgentId: null, senderSessionId: "other-main" },
			{ body: "normal update", id: 8, senderAgentId: null, senderSessionId: "other-main" },
		];

		expect(createArchitectObservation(previous, [session], messages)).toBeUndefined();
	});

	it("keeps only the newest live session per ID in the observation", () => {
		const fixtureDir = join(tmpdir(), `pi-architect-live-${crypto.randomUUID()}`);
		const controlDbPath = join(fixtureDir, "control.sqlite");
		mkdirSync(fixtureDir);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE session_metadata (
					id TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT, goal_json TEXT,
					is_subagent INTEGER NOT NULL, modified_at TEXT NOT NULL, updated_at TEXT NOT NULL
				);
				CREATE TABLE session_health (
					session_id TEXT NOT NULL, pid INTEGER, check_status TEXT NOT NULL,
					agent_generation INTEGER NOT NULL, checked_generation INTEGER, last_active_at TEXT
				);
				CREATE TABLE shared_channel_messages (
					id INTEGER PRIMARY KEY, sender_session_id TEXT NOT NULL,
					sender_agent_id TEXT, body TEXT NOT NULL
				);
			`);
			db.prepare("INSERT INTO session_metadata VALUES (?, ?, ?, ?, ?, ?, ?)").run(
				"live",
				"/old",
				"old",
				'{"objective":"Old"}',
				0,
				"2026-07-09T20:00:00.000Z",
				"2026-07-09T20:00:00.000Z",
			);
			db.prepare("INSERT INTO session_metadata VALUES (?, ?, ?, ?, ?, ?, ?)").run(
				"live",
				"/current",
				"current",
				'{"objective":"Current"}',
				0,
				"2026-07-09T22:00:00.000Z",
				"2026-07-09T22:00:00.000Z",
			);
			db.prepare("INSERT INTO session_metadata VALUES (?, ?, ?, ?, ?, ?, ?)").run(
				"ended",
				"/ended",
				"ended",
				'{"objective":"Ended"}',
				0,
				"2026-07-09T22:00:00.000Z",
				"2026-07-09T22:00:00.000Z",
			);
			db.prepare("INSERT INTO session_health VALUES (?, ?, ?, ?, ?, ?)").run(
				"live",
				123,
				"ok",
				1,
				1,
				new Date().toISOString(),
			);
			db.prepare("INSERT INTO session_health VALUES (?, ?, ?, ?, ?, ?)").run("ended", null, "dead", 1, 1, null);
			db.prepare("INSERT INTO shared_channel_messages VALUES (?, ?, ?, ?)").run(
				1,
				"main",
				null,
				"Architect: new request",
			);
		} finally {
			db.close();
		}
		try {
			const snapshot = readArchitectSnapshot(controlDbPath, 0);
			expect(snapshot.sessions).toEqual([
				expect.objectContaining({ cwd: "/current", goalJson: '{"objective":"Current"}', id: "live" }),
			]);
			expect(snapshot).toMatchObject({ lastChannelMessageId: 1, messages: [{ id: 1 }] });
		} finally {
			rmSync(fixtureDir, { force: true, recursive: true });
		}
	});

	it("does not create a control database when it has not been initialized", () => {
		const controlDbPath = join(tmpdir(), `pi-architect-missing-${crypto.randomUUID()}.sqlite`);

		expect(readArchitectSnapshot(controlDbPath, 0)).toEqual({ messages: [], sessions: [] });
		expect(existsSync(controlDbPath)).toBe(false);
	});

	it("starts after the shared-channel tail instead of replaying history", () => {
		const cursors: number[] = [];
		const observer = new ArchitectObserver("/unused", (lastChannelMessageId) => {
			cursors.push(lastChannelMessageId);
			return {
				lastChannelMessageId: 77,
				messages: [{ body: "Architect: historical request", id: 20, senderAgentId: null, senderSessionId: "main" }],
				sessions: [session],
			};
		});

		observer.observe();
		observer.observe();

		expect(cursors).toEqual([0, 77]);
	});

	it("does not treat channel history as a new architect request", () => {
		const reads = [
			{
				messages: [{ body: "Architect: old request", id: 3, senderAgentId: null, senderSessionId: "main" }],
				sessions: [session],
			},
			{
				messages: [{ body: "Architect: new request", id: 4, senderAgentId: null, senderSessionId: "main" }],
				sessions: [session],
			},
		];
		const observer = new ArchitectObserver("/unused", () => {
			const next = reads.shift();
			if (!next) throw new Error("unexpected read");
			return next;
		});

		expect(observer.observe()).toMatchObject({ reason: "session_state_changed", requests: [] });
		expect(observer.observe()).toMatchObject({ reason: "architect_request", requests: [{ id: 4 }] });
	});
});
