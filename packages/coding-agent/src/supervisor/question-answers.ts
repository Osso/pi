import { answerEscalatedQuestion, reviseQuestionAnswer, type SupervisorRequest } from "../core/session-control-db.ts";
import { sendQuestionCorrection, sendSupervisorReply } from "./mail.ts";
import { notifySupervisorRequest } from "./request-wake.ts";

/**
 * The user's answers to stored questions, from the Supervisor UI or the `pi questions` CLI. Both run on
 * the host that owns the Supervisor queue; replies reach the asking session through its mailbox.
 */

/**
 * Stores the user's answer to an escalated question and sends it to the asking session. Returns the
 * answered request, or undefined when another answer or a withdrawal came first.
 */
export function answerQuestionAsUser(
	controlDbPath: string,
	supervisorSessionId: string,
	requestId: number,
	answers: Record<string, string>,
): SupervisorRequest | undefined {
	const request = answerEscalatedQuestion(controlDbPath, requestId, answers);
	if (!request?.response || !request.replyTo) return undefined;
	sendSupervisorReply(controlDbPath, supervisorSessionId, request.replyTo, {
		requestKind: "question",
		response: request.response,
		answeredBy: "user",
	});
	// The Supervisor session closes its open panel for this question on the wake.
	notifySupervisorRequest(controlDbPath);
	return request;
}

/**
 * Replaces the stored answer of an answered question, or answers one that ended without an answer
 * (`late`), and sends it to the asking session as a correction. Returns the updated request, or
 * undefined when the question is still pending.
 */
export function reviseQuestionAsUser(
	controlDbPath: string,
	supervisorSessionId: string,
	requestId: number,
	answers: Record<string, string>,
	late = false,
): SupervisorRequest | undefined {
	const request = reviseQuestionAnswer(controlDbPath, requestId, answers);
	if (request?.response?.kind !== "answer" || !request.response.revisedAt || !request.replyTo) return undefined;
	const { revisedAt } = request.response;
	sendQuestionCorrection(controlDbPath, supervisorSessionId, request.replyTo, answers, revisedAt, late);
	return request;
}
