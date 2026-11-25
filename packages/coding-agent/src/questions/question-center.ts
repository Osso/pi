import { hostname } from "node:os";
import {
	listQuestionRequests,
	listUserQuestions,
	type QuestionAnswerSource,
	readSupervisorRequest,
	readUserQuestion,
	type SupervisorRequest,
	type UserQuestion,
} from "../core/session-control-db.ts";
import { listSessions } from "../core/session-directory.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import type { AskQuestionsToolInput } from "../core/tools/ask-questions.ts";
import { validateQuestions } from "../core/tools/ask-questions.ts";
import { answerQuestionAsUser, reviseQuestionAsUser } from "../supervisor/question-answers.ts";
import { askUserQuestion } from "../user-questions/ask.ts";

/**
 * The stored questions of both directions on the store host: questions agents asked the user (Supervisor
 * `question` requests) and questions the user asked agents. Used by `pi questions` and `pi control questions`.
 */

export interface QuestionCenter {
	controlDbPath: string;
	/** The Supervisor session; agent questions are answered in its name. */
	supervisorSessionId?: string;
}

export interface SessionAddress {
	sessionId: string;
	host?: string;
}

/** A question an agent asked the user; `ref` is `a<id>`. */
export interface AgentQuestionEntry {
	direction: "agent";
	ref: string;
	id: number;
	createdAt: string;
	session: SessionAddress;
	questions: AskQuestionsToolInput["questions"];
	/** `supervisor`: the Supervisor is deciding; `open`: waiting for the user. */
	state: "supervisor" | "open" | "answered" | "cancelled";
	answers?: Record<string, string>;
	answeredBy?: QuestionAnswerSource;
	revisedAt?: string;
}

/** A question the user asked an agent; `ref` is `u<id>`. */
export interface UserQuestionEntry {
	direction: "user";
	ref: string;
	id: number;
	createdAt: string;
	session: SessionAddress;
	question: string;
	parentId?: number;
	state: "open" | "answered";
	answer?: string;
	answeredAt?: string;
}

export type QuestionEntry = AgentQuestionEntry | UserQuestionEntry;

/** Opens the store on this host; fails when the configured Supervisor, and so the store, runs on another host. */
export function openQuestionCenter(settingsManager: SettingsManager, controlDbPath: string): QuestionCenter {
	const supervisor = settingsManager.getMergedSettings().supervisor;
	if (supervisor?.host && supervisor.host !== hostname()) {
		throw new Error(`The question store is on ${supervisor.host}; run pi questions there.`);
	}
	return { controlDbPath, supervisorSessionId: supervisor?.sessionId };
}

function agentState(request: SupervisorRequest): AgentQuestionEntry["state"] {
	if (request.response?.kind === "answer") return "answered";
	if (request.status === "escalated") return "open";
	if (request.status === "pending" || request.status === "claimed") return "supervisor";
	return "cancelled";
}

function toAgentEntry(request: SupervisorRequest): AgentQuestionEntry {
	const response = request.response?.kind === "answer" ? request.response : undefined;
	return {
		direction: "agent",
		ref: `a${request.id}`,
		id: request.id,
		createdAt: request.createdAt,
		session: { sessionId: request.senderSessionId, host: request.replyTo?.host },
		questions: request.payload.questions as AskQuestionsToolInput["questions"],
		state: agentState(request),
		...(response
			? {
					answers: Object.fromEntries(Object.entries(response.answers).map(([q, entry]) => [q, entry.answer])),
					answeredBy: response.answeredBy ?? "supervisor",
					revisedAt: response.revisedAt,
				}
			: {}),
	};
}

function toUserEntry(question: UserQuestion): UserQuestionEntry {
	return {
		direction: "user",
		ref: `u${question.id}`,
		id: question.id,
		createdAt: question.createdAt,
		session: { sessionId: question.targetSessionId, host: question.targetHost ?? undefined },
		question: question.question,
		parentId: question.parentId ?? undefined,
		state: question.status,
		answer: question.answer ?? undefined,
		answeredAt: question.answeredAt ?? undefined,
	};
}

/** Every stored question of the last three days, newest first. */
export function listQuestionEntries(center: QuestionCenter): QuestionEntry[] {
	const entries: QuestionEntry[] = [
		...listQuestionRequests(center.controlDbPath).map(toAgentEntry),
		...listUserQuestions(center.controlDbPath).map(toUserEntry),
	];
	return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readQuestionEntry(center: QuestionCenter, ref: string): QuestionEntry {
	const match = /^([au])(\d+)$/.exec(ref);
	if (!match) throw new Error(`Invalid question reference ${ref}; expected a<id> or u<id>.`);
	const id = Number(match[2]);
	if (match[1] === "a") {
		const request = readSupervisorRequest(center.controlDbPath, id);
		if (request?.kind !== "question") throw new Error(`No stored agent question ${ref}.`);
		return toAgentEntry(request);
	}
	const question = readUserQuestion(center.controlDbPath, id);
	if (!question) throw new Error(`No stored user question ${ref}.`);
	return toUserEntry(question);
}

function requireCompleteAnswers(entry: AgentQuestionEntry, answers: Record<string, string>): void {
	const asked = new Set(entry.questions.map((question) => question.question));
	for (const question of Object.keys(answers)) {
		if (!asked.has(question)) throw new Error(`${entry.ref} does not ask "${question}".`);
	}
	for (const question of asked) {
		if (!answers[question]?.trim()) throw new Error(`Missing answer for "${question}".`);
	}
}

/**
 * Answers an agent question waiting for the user, or revises one that already has an answer.
 * Returns which of the two happened.
 */
export function answerAgentQuestion(
	center: QuestionCenter,
	entry: AgentQuestionEntry,
	answers: Record<string, string>,
): "answered" | "revised" {
	if (!center.supervisorSessionId) throw new Error("No Supervisor session is configured.");
	requireCompleteAnswers(entry, answers);
	if (entry.state === "open") {
		if (answerQuestionAsUser(center.controlDbPath, center.supervisorSessionId, entry.id, answers)) return "answered";
		throw new Error(`${entry.ref} was answered or withdrawn first.`);
	}
	if (entry.state === "answered") {
		if (reviseQuestionAsUser(center.controlDbPath, center.supervisorSessionId, entry.id, answers)) return "revised";
		throw new Error(`${entry.ref} could not be revised.`);
	}
	throw new Error(
		entry.state === "supervisor"
			? `${entry.ref} is still with the Supervisor.`
			: `${entry.ref} was cancelled without an answer.`,
	);
}

/** Asks a session a question; with `followUpOf`, asks the session that answered that question. */
export function askAgent(
	center: QuestionCenter,
	target: SessionAddress | { followUpOf: UserQuestionEntry },
	question: string,
): UserQuestionEntry {
	const text = question.trim();
	if (!text) throw new Error("The question is empty.");
	const id =
		"followUpOf" in target
			? askUserQuestion(center.controlDbPath, target.followUpOf.session, text, target.followUpOf.id)
			: askUserQuestion(center.controlDbPath, target, text);
	return readQuestionEntry(center, `u${id}`) as UserQuestionEntry;
}

export interface AskTarget extends SessionAddress {
	label: string;
}

/**
 * Sessions the user can ask: running main sessions on this host, and sessions on other hosts that
 * appear in stored questions (there is no remote session discovery).
 */
export function listAskTargets(center: QuestionCenter): AskTarget[] {
	const targets = new Map<string, AskTarget>();
	for (const session of listSessions(center.controlDbPath, { includeEnded: false })) {
		if (!session.eligibleToReceive || session.sessionId === center.supervisorSessionId) continue;
		const name = session.name ?? session.goal ?? session.cwd ?? "";
		targets.set(session.sessionId, { sessionId: session.sessionId, label: `${session.sessionId} ${name}`.trim() });
	}
	for (const entry of listQuestionEntries(center)) {
		const { sessionId, host } = entry.session;
		if (!host || targets.has(sessionId)) continue;
		targets.set(sessionId, { sessionId, host, label: `${host}:${sessionId}` });
	}
	return [...targets.values()];
}

/** Validates stored agent questions before they open in a panel. */
export function panelQuestions(entry: AgentQuestionEntry): AskQuestionsToolInput["questions"] {
	validateQuestions(entry.questions);
	return entry.questions;
}
