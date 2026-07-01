import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimLatestIncomingMessage,
	claimRuntimeMailboxMessages,
	cleanupRuntimeMailboxMessages,
	completeIncomingMessage,
	enqueueIncomingMessage,
	enqueueRuntimeMailboxMessage,
	failRuntimeMailboxMessage,
	getControlDbPath,
	listNamedSessions,
	listRuntimeMailboxMessages,
	listSessionMetadata,
	markRuntimeMailboxMessageDelivered,
	readIncomingMessageStatus,
	readLastMessage,
	readRuntimeMailboxMessage,
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

	it("stores runtime mailbox messages by recipient session and nullable agent id", () => {
		const mainMessageId = enqueueRuntimeMailboxMessage(controlDbPath, {
			body: "main thread notice",
			kind: "system",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const agentMessageId = enqueueRuntimeMailboxMessage(controlDbPath, {
			body: "subagent notice",
			kind: "message",
			recipient: { agentId: "agent_2", sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});

		expect(readRuntimeMailboxMessage(controlDbPath, mainMessageId)).toMatchObject({
			body: "main thread notice",
			kind: "system",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
			status: "pending",
		});
		expect(
			claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" }).map(
				(message) => message.id,
			),
		).toEqual([mainMessageId]);
		expect(readRuntimeMailboxMessage(controlDbPath, agentMessageId)).toMatchObject({ status: "pending" });
	});

	it("claims runtime mailbox rows atomically before delivery", () => {
		const firstId = enqueueRuntimeMailboxMessage(controlDbPath, {
			body: "first",
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const secondId = enqueueRuntimeMailboxMessage(controlDbPath, {
			body: "second",
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_2", sessionId: "child-session" },
		});

		const firstClaim = claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });
		const secondClaim = claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });

		expect(firstClaim.map((message) => message.id)).toEqual([firstId, secondId]);
		expect(secondClaim).toEqual([]);
		expect(readRuntimeMailboxMessage(controlDbPath, firstId)).toMatchObject({ status: "claimed" });
		expect(readRuntimeMailboxMessage(controlDbPath, secondId)).toMatchObject({ status: "claimed" });
	});

	it("marks runtime mailbox rows delivered only after enqueue and failed on enqueue failure", () => {
		const deliveredId = enqueueRuntimeMailboxMessage(controlDbPath, {
			body: "delivered",
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const failedId = enqueueRuntimeMailboxMessage(controlDbPath, {
			body: "failed",
			kind: "message",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_2", sessionId: "child-session" },
		});
		claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });

		markRuntimeMailboxMessageDelivered(controlDbPath, deliveredId);
		failRuntimeMailboxMessage(controlDbPath, failedId, "enqueue failed");

		expect(readRuntimeMailboxMessage(controlDbPath, deliveredId)).toMatchObject({ status: "delivered" });
		expect(readRuntimeMailboxMessage(controlDbPath, failedId)).toMatchObject({
			error: "enqueue failed",
			status: "failed",
		});
	});

	it("cleans runtime mailbox rows older than thirty days", () => {
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE runtime_mailbox_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					recipient_session_id TEXT NOT NULL,
					recipient_agent_id TEXT,
					sender_session_id TEXT,
					sender_agent_id TEXT,
					kind TEXT NOT NULL,
					body TEXT NOT NULL,
					artifact_ids_json TEXT,
					artifact_refs_json TEXT,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					claimed_at TEXT,
					delivered_at TEXT,
					error TEXT
				);
			`);
			db.prepare(
				`INSERT INTO runtime_mailbox_messages (recipient_session_id, kind, body, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run("parent-session", "message", "old", "pending", "2026-05-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z");
			db.prepare(
				`INSERT INTO runtime_mailbox_messages (recipient_session_id, kind, body, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run("parent-session", "message", "new", "pending", "2026-06-15T00:00:00.000Z", "2026-06-15T00:00:00.000Z");
		} finally {
			db.close();
		}

		expect(cleanupRuntimeMailboxMessages(controlDbPath, "2026-07-01T00:00:00.000Z")).toBe(1);
		expect(listRuntimeMailboxMessages(controlDbPath).map((message) => message.body)).toEqual(["new"]);
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
