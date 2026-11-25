import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importRelayMailbox, nextRelayMailbox } from "../src/core/host-relay-store.ts";
import { cleanupExpiredMessages, withControlDb } from "../src/core/session-control-db/connection.ts";
import {
	listUserQuestions,
	postUserQuestion,
	readUserQuestion,
	recordUserQuestionAnswer,
} from "../src/core/session-control-db/user-questions.ts";
import {
	enqueueStoredRuntimeMailboxMessage,
	listRuntimeMailboxMessagesForSession,
} from "../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";
import { askUserQuestion } from "../src/user-questions/ask.ts";

const directories: string[] = [];
function makeDbPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-user-questions-"));
	directories.push(directory);
	return join(directory, "control.sqlite");
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("user question storage", () => {
	it("delivers follow-ups to the original target with the earlier answer", () => {
		const path = makeDbPath();
		const firstId = askUserQuestion(path, { sessionId: "original-session", host: "agent-server" }, "First?");
		recordUserQuestionAnswer(path, firstId, "Earlier answer");
		const followUpId = askUserQuestion(path, { sessionId: "wrong-session" }, "Follow-up?", firstId);
		const question = readUserQuestion(path, followUpId);
		const message = listRuntimeMailboxMessagesForSession(path, "user-questions").find(
			(entry) => entry.storeRef.messageId === `user_question:${followUpId}`,
		);
		if (!message) throw new Error("Follow-up mailbox message was not stored");
		expect(question).toMatchObject({
			parentId: firstId,
			targetHost: "agent-server",
			targetSessionId: "original-session",
		});
		expect(message.body).toContain(
			`User follow-up question ${followUpId} (to question ${firstId}: "First?" → "Earlier answer"): Follow-up?`,
		);
		expect(message.body).toContain(`answer_user_question { id: ${followUpId}, answer }`);
	});

	it("stores questions, orders newest first, and allows answer updates", () => {
		const path = makeDbPath();
		const firstId = postUserQuestion(path, { targetSessionId: "session", question: "First?" });
		const secondId = postUserQuestion(path, {
			targetHost: "agent-server",
			targetSessionId: "remote-session",
			question: "Follow-up?",
			parentId: firstId,
		});
		expect(readUserQuestion(path, secondId)).toMatchObject({
			parentId: firstId,
			targetHost: "agent-server",
			targetSessionId: "remote-session",
			status: "open",
		});
		expect(listUserQuestions(path).map((question) => question.id)).toEqual([secondId, firstId]);
		expect(recordUserQuestionAnswer(path, secondId, "Answer one")).toBe(true);
		expect(recordUserQuestionAnswer(path, secondId, "Revised answer")).toBe(true);
		expect(recordUserQuestionAnswer(path, 9999, "Unknown")).toBe(false);
		expect(readUserQuestion(path, secondId)).toMatchObject({ status: "answered", answer: "Revised answer" });
	});

	it("removes questions older than the three-day retention period", () => {
		const path = makeDbPath();
		const expired = postUserQuestion(path, { targetSessionId: "session", question: "Expired?" });
		const current = postUserQuestion(path, {
			targetSessionId: "session",
			question: "Current?",
			parentId: expired,
		});
		withControlDb(path, (db) => {
			db.prepare("UPDATE user_questions SET created_at = ? WHERE id = ?").run(
				new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 - 1000).toISOString(),
				expired,
			);
			cleanupExpiredMessages(db);
		});
		expect(readUserQuestion(path, expired)).toBeUndefined();
		expect(readUserQuestion(path, current)).toBeDefined();
	});

	it("records an answer imported from a remote host without queuing it for a session", () => {
		const senderDb = makeDbPath();
		const storeDb = makeDbPath();
		const id = postUserQuestion(storeDb, { targetSessionId: "remote-session", question: "Remote?" });
		const messageId = `user_question_answer:agent-server:${id}`;
		enqueueStoredRuntimeMailboxMessage(senderDb, {
			kind: "message",
			recipientHost: "aso",
			recipient: { sessionId: "supervisor", agentId: null },
			sender: { sessionId: "remote-session", agentId: null },
			storeRef: { sessionPath: "user-questions", messageId },
			message: {
				id: messageId,
				kind: "message",
				status: "pending",
				fromAgentId: "main",
				toAgentId: "main",
				body: JSON.stringify({ id, answer: "Recorded remotely" }),
				createdAt: new Date().toISOString(),
			},
		});
		const relayed = nextRelayMailbox(senderDb, "aso");
		if (!relayed) throw new Error("Expected the remote answer to be queued for relay");
		importRelayMailbox(storeDb, "agent-server", relayed, "aso");
		expect(readUserQuestion(storeDb, id)).toMatchObject({ status: "answered", answer: "Recorded remotely" });
		const db = createSqliteDatabase(storeDb);
		try {
			expect(
				(db.prepare("SELECT COUNT(*) AS count FROM multi_agent_mailbox_messages").get() as { count: number }).count,
			).toBe(0);
		} finally {
			db.close();
		}
	});
});
