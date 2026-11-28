import { hostname } from "node:os";
import { getAgentDir } from "../config.ts";
import { getControlDbPath } from "../core/session-control-db.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import {
	type AgentQuestionEntry,
	listQuestionEntries,
	openQuestionCenter,
	type QuestionCenter,
} from "../questions/question-center.ts";
import type { Worker } from "./server-command.ts";

export function questionStoreHost(): string {
	const settings = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	return settings.getMergedSettings().supervisor?.host ?? hostname();
}

export function controlCenter(): QuestionCenter | undefined {
	const settings = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	if ((settings.getMergedSettings().supervisor?.host ?? hostname()) !== hostname()) return undefined;
	return openQuestionCenter(settings, getControlDbPath());
}

export function makeQuestionSummary(entry: AgentQuestionEntry) {
	return {
		questionId: entry.ref,
		sessionId: entry.session.sessionId,
		originSessionId: entry.session.sessionId,
		agentId: null,
		toolCallId: entry.toolCallId,
		blocking: entry.blocking,
		questions: entry.questions,
		createdAt: entry.createdAt,
		state: entry.state === "open" ? "pending" : entry.state,
		review: "escalated",
		answerable: entry.state === "open",
		...(entry.answers ? { answers: entry.answers } : {}),
		...(entry.answeredBy ? { answeredBy: entry.answeredBy } : {}),
	};
}

export function questionUpdates(workers: Map<string, Worker>): Array<Record<string, unknown>> {
	const center = controlCenter();
	const stored = (center ? listQuestionEntries(center) : [])
		.filter((entry): entry is AgentQuestionEntry => entry.direction === "agent" && entry.state !== "supervisor")
		.map(makeQuestionSummary);
	const pending = [...workers.values()].flatMap((worker) =>
		[...worker.directQuestions].map(([questionId, question]) => ({
			questionId,
			sessionId: worker.sessionId,
			originSessionId: worker.sessionId,
			agentId: null,
			toolCallId: question.toolCallId,
			blocking: question.blocking,
			questions: question.questions,
			createdAt: question.createdAt,
			state: "pending",
			review: question.review,
			answerable: true,
		})),
	);
	const answered = [...workers.values()].flatMap((worker) =>
		[...worker.answeredDirectQuestions.values()].map((answer) => answer.question),
	);
	return [...stored, ...pending, ...answered];
}

export function questionSummaries(workers: Map<string, Worker>): Array<Record<string, unknown>> {
	return questionUpdates(workers).filter((question) => question.state === "pending");
}

export function sameAnswers(left: Record<string, string> | undefined, right: Record<string, string>): boolean {
	if (!left) return false;
	const entries = Object.entries(right);
	return (
		entries.length === Object.keys(left).length && entries.every(([question, answer]) => left[question] === answer)
	);
}
