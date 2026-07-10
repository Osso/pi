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

	it("retains the live session across goal completion and stabilizes on the next snapshot", () => {
		const previous = createArchitectObservation(undefined, [session], []);
		if (!previous) throw new Error("expected initial observation");
		const completed = {
			...session,
			goalJson: '{"objective":"Keep tests green","completedAt":"2026-07-10T00:00:00.000Z"}',
		};
		const completionObservation = createArchitectObservation(previous, [completed], []);

		expect(completionObservation).toMatchObject({
			reason: "session_state_changed",
			sessions: [expect.objectContaining({ id: session.id })],
		});
		if (!completionObservation) throw new Error("expected completion observation");
		expect(createArchitectObservation(completionObservation, [completed], [])).toBeUndefined();
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

	it("keeps the deterministic newest live metadata row per session ID", () => {
		const fixtureDir = join(tmpdir(), `pi-architect-live-${crypto.randomUUID()}`);
		const controlDbPath = join(fixtureDir, "control.sqlite");
		mkdirSync(fixtureDir);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE session_metadata (
					session_path TEXT NOT NULL, id TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT, goal_json TEXT,
					is_subagent INTEGER NOT NULL, modified_at TEXT NOT NULL, updated_at TEXT NOT NULL
				);
				CREATE TABLE session_health (
					session_id TEXT NOT NULL, pid INTEGER, check_status TEXT NOT NULL,
					agent_generation INTEGER NOT NULL, checked_generation INTEGER, last_active_at TEXT
				);
				CREATE TABLE runtime_mailbox_listeners (
					recipient_session_id TEXT NOT NULL, recipient_agent_id_key TEXT NOT NULL,
					pid INTEGER NOT NULL, updated_at TEXT NOT NULL
				);
				CREATE TABLE shared_channel_messages (
					id INTEGER PRIMARY KEY, sender_session_id TEXT NOT NULL,
					sender_agent_id TEXT, body TEXT NOT NULL
				);
			`);
			const insertMetadata = db.prepare("INSERT INTO session_metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
			insertMetadata.run(
				"a-old.jsonl",
				"live",
				"/old",
				"old",
				'{"objective":"Old"}',
				0,
				"2026-07-09T20:00:00.000Z",
				"2026-07-09T20:00:00.000Z",
			);
			insertMetadata.run(
				"z-current.jsonl",
				"live",
				"/current",
				"current",
				'{"objective":"Current"}',
				0,
				"2026-07-09T22:00:00.000Z",
				"2026-07-09T22:00:00.000Z",
			);
			insertMetadata.run(
				"a-current-stale.jsonl",
				"live",
				"/stale",
				"stale",
				'{"objective":"Stale"}',
				0,
				"2026-07-09T22:00:00.000Z",
				"2026-07-09T22:00:00.000Z",
			);
			insertMetadata.run(
				"ended.jsonl",
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
			db.prepare("INSERT INTO runtime_mailbox_listeners VALUES (?, ?, ?, ?)").run(
				"live",
				"",
				123,
				"2026-07-09T19:00:00.000Z",
			);
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

	it("keeps the most recently registered main session for each live process", () => {
		const fixtureDir = join(tmpdir(), `pi-architect-current-${crypto.randomUUID()}`);
		const controlDbPath = join(fixtureDir, "control.sqlite");
		mkdirSync(fixtureDir);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE session_metadata (
					session_path TEXT NOT NULL, id TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT, goal_json TEXT,
					is_subagent INTEGER NOT NULL, modified_at TEXT NOT NULL, updated_at TEXT NOT NULL
				);
				CREATE TABLE session_health (
					session_id TEXT NOT NULL, pid INTEGER, check_status TEXT NOT NULL,
					agent_generation INTEGER NOT NULL, checked_generation INTEGER, last_active_at TEXT
				);
				CREATE TABLE runtime_mailbox_listeners (
					recipient_session_id TEXT NOT NULL, recipient_agent_id_key TEXT NOT NULL,
					pid INTEGER NOT NULL, updated_at TEXT NOT NULL
				);
				CREATE TABLE shared_channel_messages (
					id INTEGER PRIMARY KEY, sender_session_id TEXT NOT NULL,
					sender_agent_id TEXT, body TEXT NOT NULL
				);
			`);
			const insertMetadata = db.prepare("INSERT INTO session_metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
			insertMetadata.run(
				"historical-main.jsonl",
				"historical-main",
				"/old",
				"old",
				'{"objective":"Old"}',
				0,
				"2026-07-09T23:00:00.000Z",
				"2026-07-09T23:00:00.000Z",
			);
			insertMetadata.run(
				"current-main.jsonl",
				"current-main",
				"/current",
				"current",
				'{"objective":"Current"}',
				0,
				"2026-07-09T22:00:00.000Z",
				"2026-07-09T22:00:00.000Z",
			);
			insertMetadata.run(
				"current-child.jsonl",
				"current-child",
				"/current",
				"child",
				null,
				1,
				"2026-07-09T23:30:00.000Z",
				"2026-07-09T23:30:00.000Z",
			);
			insertMetadata.run(
				"other-main.jsonl",
				"other-main",
				"/other",
				"other",
				'{"objective":"Other"}',
				0,
				"2026-07-09T21:00:00.000Z",
				"2026-07-09T21:00:00.000Z",
			);
			insertMetadata.run(
				"architect.jsonl",
				"architect",
				"/home/osso",
				null,
				null,
				0,
				"2026-07-09T23:30:00.000Z",
				"2026-07-09T23:30:00.000Z",
			);
			const insertHealth = db.prepare("INSERT INTO session_health VALUES (?, ?, ?, ?, ?, ?)");
			const now = new Date().toISOString();
			insertHealth.run("historical-main", 123, "ok", 1, 1, now);
			insertHealth.run("current-main", 123, "ok", 1, 1, now);
			insertHealth.run("current-child", 123, "ok", 1, 1, now);
			insertHealth.run("other-main", 456, "ok", 1, 1, now);
			insertHealth.run("architect", 789, "ok", 1, 1, now);
			const insertListener = db.prepare("INSERT INTO runtime_mailbox_listeners VALUES (?, ?, ?, ?)");
			insertListener.run("historical-main", "", 123, "2026-07-09T20:00:00.000Z");
			insertListener.run("current-main", "", 123, "2026-07-09T21:00:00.000Z");
			insertListener.run("current-child", "", 123, "2026-07-09T23:30:00.000Z");
			insertListener.run("other-main", "", 456, "2026-07-09T19:00:00.000Z");
			insertListener.run("architect", "", 789, "2026-07-09T23:30:00.000Z");
		} finally {
			db.close();
		}
		try {
			expect(readArchitectSnapshot(controlDbPath, 0).sessions).toEqual([
				expect.objectContaining({ id: "current-main" }),
				expect.objectContaining({ id: "other-main" }),
			]);
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
