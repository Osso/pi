import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	answerEscalatedQuestion,
	cancelSupervisorRequest,
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	listQuestionRequests,
	postSupervisorRequest,
	readSupervisorRequest,
	reviseQuestionAnswer,
} from "../src/core/session-control-db.ts";

const QUESTION = "Which test runner should this project use?";

describe("Supervisor question store", () => {
	let tempDir: string;
	let controlDbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-question-store-"));
		controlDbPath = getControlDbPath(tempDir);
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(tempDir, { force: true, recursive: true });
	});

	function postQuestion(requestId: string): number {
		return postSupervisorRequest(controlDbPath, {
			deadlineAt: "9999-12-31T23:59:59.999Z",
			kind: "question",
			payload: { blocking: true, questions: [{ question: QUESTION }] },
			projectId: "pi",
			replyTo: { sessionId: "asker", agentId: null, requestId },
			senderSessionId: "asker",
		});
	}

	function decide(id: number, response: Parameters<typeof completeSupervisorRequest>[3]): void {
		const claimed = claimNextSupervisorRequest(controlDbPath, `claim-${id}`);
		if (claimed?.id !== id || !claimed.claimToken) throw new Error(`expected claim of ${id}`);
		completeSupervisorRequest(controlDbPath, id, claimed.claimToken, response);
	}

	it("keeps an escalated question open until the first user answer", () => {
		const id = postQuestion("call-1");
		decide(id, { kind: "escalate", reason: "Product tradeoff." });
		expect(readSupervisorRequest(controlDbPath, id)).toMatchObject({ status: "escalated", completedAt: undefined });

		const answered = answerEscalatedQuestion(controlDbPath, id, { [QUESTION]: "vitest" });
		expect(answered).toMatchObject({
			status: "completed",
			response: { kind: "answer", answeredBy: "user", answers: { [QUESTION]: { answer: "vitest" } } },
		});
		expect(answerEscalatedQuestion(controlDbPath, id, { [QUESTION]: "jest" })).toBeUndefined();
		expect(readSupervisorRequest(controlDbPath, id)?.response).toMatchObject({
			answers: { [QUESTION]: { answer: "vitest" } },
		});
	});

	it("stores the asker's local answer when it withdraws an escalated question", () => {
		const id = postQuestion("call-2");
		decide(id, { kind: "escalate", reason: "Product tradeoff." });

		const route = { sessionId: "asker", agentId: null, requestId: "call-2" };
		expect(cancelSupervisorRequest(controlDbPath, route, "Answered locally", { [QUESTION]: "jest" })).toBe(true);

		expect(readSupervisorRequest(controlDbPath, id)).toMatchObject({
			status: "cancelled",
			response: { kind: "answer", answeredBy: "local", answers: { [QUESTION]: { answer: "jest" } } },
		});
		expect(answerEscalatedQuestion(controlDbPath, id, { [QUESTION]: "vitest" })).toBeUndefined();
	});

	it("does not withdraw a question that already has an answer", () => {
		const id = postQuestion("call-3");
		decide(id, { kind: "answer", answers: { [QUESTION]: { answer: "vitest", reason: "AGENTS.md" } } });

		const route = { sessionId: "asker", agentId: null, requestId: "call-3" };
		expect(cancelSupervisorRequest(controlDbPath, route, "late", { [QUESTION]: "jest" })).toBe(false);
		expect(readSupervisorRequest(controlDbPath, id)).toMatchObject({
			status: "completed",
			response: { answers: { [QUESTION]: { answer: "vitest", reason: "AGENTS.md" } } },
		});
	});

	it("revises only questions that have an answer", () => {
		const supervisorAnswered = postQuestion("call-4");
		decide(supervisorAnswered, {
			kind: "answer",
			answers: { [QUESTION]: { answer: "vitest", reason: "AGENTS.md" } },
		});
		const escalated = postQuestion("call-5");
		decide(escalated, { kind: "escalate", reason: "Product tradeoff." });

		const revised = reviseQuestionAnswer(controlDbPath, supervisorAnswered, { [QUESTION]: "jest" });
		expect(revised?.response).toMatchObject({
			kind: "answer",
			answeredBy: "user",
			answers: { [QUESTION]: { answer: "jest" } },
		});
		expect(revised?.response?.kind === "answer" && revised.response.revisedAt).toEqual(expect.any(String));
		expect(reviseQuestionAnswer(controlDbPath, escalated, { [QUESTION]: "jest" })).toBeUndefined();
		expect(readSupervisorRequest(controlDbPath, escalated)?.status).toBe("escalated");
	});

	it("keeps question rows three days from creation and other requests 24 hours after they finish", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
		const answered = postQuestion("old-answered");
		decide(answered, { kind: "answer", answers: { [QUESTION]: { answer: "vitest", reason: "AGENTS.md" } } });
		const escalated = postQuestion("old-escalated");
		decide(escalated, { kind: "escalate", reason: "Product tradeoff." });
		const review = postSupervisorRequest(controlDbPath, {
			deadlineAt: "2026-12-01T00:00:00.000Z",
			kind: "goal_idle_review",
			payload: { objective: "ship" },
			projectId: "pi",
			senderSessionId: "goal-session",
		});
		decide(review, { kind: "pause", reason: "done" });

		vi.setSystemTime(new Date("2026-11-02T00:00:30.000Z"));
		expect(readSupervisorRequest(controlDbPath, review)).toBeUndefined();
		expect(listQuestionRequests(controlDbPath).map((request) => request.id)).toEqual([escalated, answered]);

		vi.setSystemTime(new Date("2026-11-03T23:59:00.000Z"));
		expect(readSupervisorRequest(controlDbPath, answered)?.status).toBe("completed");

		vi.setSystemTime(new Date("2026-11-04T00:00:30.000Z"));
		expect(readSupervisorRequest(controlDbPath, answered)).toBeUndefined();
		expect(readSupervisorRequest(controlDbPath, escalated)).toBeUndefined();
		expect(listQuestionRequests(controlDbPath)).toEqual([]);
	});
});
