import { type AgentQuestionEntry, answerAgentQuestion, listQuestionEntries } from "../questions/question-center.ts";
import type { CommandContext, Worker } from "./server-command.ts";
import { controlCenter, makeQuestionSummary, questionStoreHost, sameAnswers } from "./server-question-utils.ts";

function validateAnswerMap(value: unknown, fail: CommandContext["fail"]): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail("invalid_request", "questionId and answers are required");
		return undefined;
	}
	if (!Object.values(value).every((answer) => typeof answer === "string")) {
		fail("invalid_answer", "Every answer must be text");
		return undefined;
	}
	return value as Record<string, string>;
}

function answerDirectQuestion(
	questionId: string,
	answers: Record<string, string>,
	workers: Map<string, Worker>,
	respond: CommandContext["respond"],
	fail: CommandContext["fail"],
): boolean {
	for (const worker of workers.values()) {
		const previousAnswer = worker.answeredDirectQuestions.get(questionId);
		if (previousAnswer) {
			if (!sameAnswers(previousAnswer.answers, answers)) {
				fail("already_resolved", "Question was answered with different values");
				return true;
			}
			respond({ question: previousAnswer.question, delivery: "accepted" });
			return true;
		}
		const direct = worker.directQuestions.get(questionId);
		if (!direct) continue;
		if (direct.questions.some((question) => !answers[question.question]?.trim())) {
			fail("invalid_answer", "An answer is required for every question");
			return true;
		}
		if (!worker.child.stdin?.writable) {
			fail("stale_runtime", "Question runtime is not available");
			return true;
		}
		worker.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: direct.dialogId, answers })}\n`);
		worker.directQuestions.delete(questionId);
		const question = {
			questionId,
			sessionId: worker.sessionId,
			originSessionId: worker.sessionId,
			agentId: null,
			toolCallId: direct.toolCallId,
			blocking: direct.blocking,
			questions: direct.questions,
			createdAt: direct.createdAt,
			state: "answered",
			review: direct.review,
			answerable: false,
			answers,
			answeredBy: "user",
			delivery: "accepted",
		};
		worker.answeredDirectQuestions.set(questionId, { answers, question });
		respond({ question, delivery: "accepted" });
		return true;
	}
	return false;
}

function answerEscalatedQuestion(
	questionId: string,
	answers: Record<string, string>,
	respond: CommandContext["respond"],
	fail: CommandContext["fail"],
): void {
	const center = controlCenter();
	if (!center) {
		fail("not_found", `Question not found on this host; the question store is on ${questionStoreHost()}`);
		return;
	}
	const entry = listQuestionEntries(center).find(
		(item): item is AgentQuestionEntry => item.direction === "agent" && item.ref === questionId,
	);
	if (!entry) {
		fail("not_found", "Question not found");
		return;
	}
	if (entry.state === "answered" && sameAnswers(entry.answers, answers)) {
		respond({ question: makeQuestionSummary(entry), delivery: "delivered" });
		return;
	}
	if (entry.state !== "open") {
		fail("already_resolved", "Question is no longer pending");
		return;
	}
	answerAgentQuestion(center, entry, answers);
	const updated = listQuestionEntries(center).find(
		(item): item is AgentQuestionEntry => item.direction === "agent" && item.ref === questionId,
	);
	const question = updated
		? makeQuestionSummary(updated)
		: makeQuestionSummary({ ...entry, state: "answered", answers, answeredBy: "user" });
	respond({ question, delivery: "delivered" });
}

export async function handleAnswerQuestion({ frame, workers, respond, fail }: CommandContext): Promise<void> {
	if (typeof frame.questionId !== "string") return fail("invalid_request", "questionId and answers are required");
	const answers = validateAnswerMap(frame.answers, fail);
	if (!answers) return;
	if (answerDirectQuestion(frame.questionId, answers, workers, respond, fail)) return;
	answerEscalatedQuestion(frame.questionId, answers, respond, fail);
}
