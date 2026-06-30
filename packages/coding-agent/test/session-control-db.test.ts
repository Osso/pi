import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimLatestIncomingMessage,
	completeIncomingMessage,
	enqueueIncomingMessage,
	getControlDbPath,
	listNamedSessions,
	listSessionMetadata,
	readIncomingMessageStatus,
	readLastMessage,
	readSessionGoal,
	readSessionMetadata,
	removeNamedSession,
	setNamedSession,
	writeLastMessage,
	writeSessionGoal,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

describe("session control DB", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-control-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		rmSync(tempDir, { force: true, recursive: true });
	});

	it("stores control state next to the session transcript", () => {
		expect(controlDbPath).toBe(join(tempDir, "control.sqlite"));
	});

	it("claims only the latest pending incoming message", () => {
		enqueueIncomingMessage(controlDbPath, "older prompt");
		enqueueIncomingMessage(controlDbPath, "newer prompt");

		const claimed = claimLatestIncomingMessage(controlDbPath);

		expect(claimed?.content).toBe("newer prompt");
		expect(claimLatestIncomingMessage(controlDbPath)).toBeUndefined();
	});

	it("allows claimed incoming messages to be completed", () => {
		enqueueIncomingMessage(controlDbPath, "run this");
		const claimed = claimLatestIncomingMessage(controlDbPath);

		expect(claimed).toBeDefined();
		completeIncomingMessage(controlDbPath, claimed!.id);

		expect(readIncomingMessageStatus(controlDbPath, claimed!.id)).toBe("completed");
		expect(claimLatestIncomingMessage(controlDbPath)).toBeUndefined();
	});

	it("keeps only the latest assistant message", () => {
		writeLastMessage(controlDbPath, { role: "assistant", content: "first answer" });
		writeLastMessage(controlDbPath, { role: "assistant", content: "second answer" });

		expect(readLastMessage(controlDbPath)).toMatchObject({
			role: "assistant",
			content: "second answer",
		});
	});

	it("stores and removes named sessions", () => {
		setNamedSession(controlDbPath, "/tmp/session-a.jsonl", "Alpha");
		setNamedSession(controlDbPath, "/tmp/session-b.jsonl", "Beta");
		setNamedSession(controlDbPath, "/tmp/session-a.jsonl", "Alpha renamed");

		const namedSessions = listNamedSessions(controlDbPath)
			.map((session) => [session.sessionPath, session.name])
			.sort(([left], [right]) => left.localeCompare(right));
		expect(namedSessions).toEqual([
			["/tmp/session-a.jsonl", "Alpha renamed"],
			["/tmp/session-b.jsonl", "Beta"],
		]);

		removeNamedSession(controlDbPath, "/tmp/session-a.jsonl");

		expect(listNamedSessions(controlDbPath).map((session) => [session.sessionPath, session.name])).toEqual([
			["/tmp/session-b.jsonl", "Beta"],
		]);
	});

	it("stores and lists session metadata ordered by modified time", () => {
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: "Alpha",
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 2,
			firstMessage: "first alpha",
			allMessagesText: "first alpha assistant alpha",
		});
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-b.jsonl",
			id: "session-b",
			cwd: "/repo/b",
			name: undefined,
			parentSessionPath: "/tmp/session-a.jsonl",
			createdAt: "2026-01-02T00:00:00.000Z",
			modifiedAt: "2026-01-02T00:05:00.000Z",
			messageCount: 1,
			firstMessage: "first beta",
			allMessagesText: "first beta",
		});

		const sessions = listSessionMetadata(controlDbPath);

		expect(sessions).toMatchObject([
			{
				sessionPath: "/tmp/session-b.jsonl",
				id: "session-b",
				cwd: "/repo/b",
				name: undefined,
				parentSessionPath: "/tmp/session-a.jsonl",
				createdAt: "2026-01-02T00:00:00.000Z",
				modifiedAt: "2026-01-02T00:05:00.000Z",
				messageCount: 1,
				firstMessage: "first beta",
				allMessagesText: "first beta",
			},
			{
				sessionPath: "/tmp/session-a.jsonl",
				id: "session-a",
				cwd: "/repo/a",
				name: "Alpha",
				parentSessionPath: undefined,
				createdAt: "2026-01-01T00:00:00.000Z",
				modifiedAt: "2026-01-01T00:10:00.000Z",
				messageCount: 2,
				firstMessage: "first alpha",
				allMessagesText: "first alpha assistant alpha",
			},
		]);
		expect(sessions[0].updatedAt).toEqual(expect.any(String));
	});

	it("updates existing session metadata without changing its session path", () => {
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: "Original",
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
		});
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a-renamed",
			cwd: "/repo/a2",
			name: undefined,
			parentSessionPath: "/tmp/parent.jsonl",
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:20:00.000Z",
			messageCount: 3,
			firstMessage: "updated first",
			allMessagesText: "updated first more text",
		});

		expect(readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl")).toMatchObject({
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a-renamed",
			cwd: "/repo/a2",
			name: undefined,
			parentSessionPath: "/tmp/parent.jsonl",
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:20:00.000Z",
			messageCount: 3,
			firstMessage: "updated first",
			allMessagesText: "updated first more text",
		});
	});

	it("adds goal and subagent columns to existing session metadata tables", () => {
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE session_metadata (
					session_path TEXT PRIMARY KEY,
					id TEXT NOT NULL,
					cwd TEXT NOT NULL,
					name TEXT,
					parent_session_path TEXT,
					created_at TEXT NOT NULL,
					modified_at TEXT NOT NULL,
					message_count INTEGER NOT NULL,
					first_message TEXT NOT NULL,
					all_messages_text TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
		} finally {
			db.close();
		}

		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: undefined,
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
			isSubagent: true,
			subagentName: "researcher",
		});
		writeSessionGoal(controlDbPath, "/tmp/session-a.jsonl", '{"objective":"migrated"}');

		expect(readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl")).toMatchObject({
			goalJson: '{"objective":"migrated"}',
			isSubagent: true,
			subagentName: "researcher",
		});
	});

	it("stores goal and subagent metadata in the session metadata row", () => {
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: "Alpha",
			parentSessionPath: "/tmp/parent.jsonl",
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
			isSubagent: true,
			subagentName: "researcher",
		});

		writeSessionGoal(controlDbPath, "/tmp/session-a.jsonl", '{"objective":"child objective"}');

		const metadata = readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl");
		expect(metadata).toMatchObject({
			goalJson: '{"objective":"child objective"}',
			isSubagent: true,
			subagentName: "researcher",
		});
		expect(readSessionGoal(controlDbPath, "/tmp/session-a.jsonl")).toBe('{"objective":"child objective"}');
	});

	it("keeps named session APIs compatible while mirroring names into metadata", () => {
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: undefined,
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:10:00.000Z",
			messageCount: 1,
			firstMessage: "first",
			allMessagesText: "first",
		});

		setNamedSession(controlDbPath, "/tmp/session-a.jsonl", "Alpha");
		writeSessionMetadata(controlDbPath, {
			sessionPath: "/tmp/session-a.jsonl",
			id: "session-a",
			cwd: "/repo/a",
			name: undefined,
			parentSessionPath: undefined,
			createdAt: "2026-01-01T00:00:00.000Z",
			modifiedAt: "2026-01-01T00:20:00.000Z",
			messageCount: 2,
			firstMessage: "first",
			allMessagesText: "first second",
		});

		expect(listNamedSessions(controlDbPath)).toMatchObject([{ sessionPath: "/tmp/session-a.jsonl", name: "Alpha" }]);
		expect(readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl")?.name).toBe("Alpha");

		removeNamedSession(controlDbPath, "/tmp/session-a.jsonl");

		expect(listNamedSessions(controlDbPath)).toEqual([]);
		expect(readSessionMetadata(controlDbPath, "/tmp/session-a.jsonl")?.name).toBeUndefined();
	});
});
