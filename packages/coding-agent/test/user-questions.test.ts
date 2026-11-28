import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ackRelayMailbox, importRelayMailbox, nextRelayMailbox } from "../src/core/host-relay-store.ts";
import { cleanupExpiredMessages, withControlDb } from "../src/core/session-control-db/connection.ts";
import {
	listUserQuestions,
	postUserQuestion,
	readUserQuestion,
	recordUserQuestionAnswer,
} from "../src/core/session-control-db/user-questions.ts";
import { listRuntimeMailboxMessagesForSession } from "../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";
import { sendRemoteUserQuestionAnswer } from "../src/core/tools/answer-user-question.ts";
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

	it("records remote answers and a later revision imported in order, without queuing them for a session", () => {
		const senderDb = makeDbPath();
		const storeDb = makeDbPath();
		const id = postUserQuestion(storeDb, { targetSessionId: "remote-session", question: "Remote?" });
		const supervisor = { sessionId: "supervisor", host: "aso" };
		// The revision is queued while the first answer is still waiting for the relay.
		sendRemoteUserQuestionAnswer(senderDb, supervisor, { id, answer: "Recorded remotely" });
		sendRemoteUserQuestionAnswer(senderDb, supervisor, { id, answer: "Revised remotely" });

		const first = nextRelayMailbox(senderDb, "aso");
		if (!first) throw new Error("Expected the first answer to be queued for relay");
		importRelayMailbox(storeDb, "agent-server", first, "aso");
		expect(readUserQuestion(storeDb, id)).toMatchObject({ status: "answered", answer: "Recorded remotely" });
		ackRelayMailbox(senderDb, first);
		const second = nextRelayMailbox(senderDb, "aso");
		if (!second) throw new Error("Expected the revision to be queued for relay");
		importRelayMailbox(storeDb, "agent-server", second, "aso");
		expect(readUserQuestion(storeDb, id)).toMatchObject({ status: "answered", answer: "Revised remotely" });

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
