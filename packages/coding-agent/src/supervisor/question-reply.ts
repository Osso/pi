import {
	enqueueStoredRuntimeMailboxMessage,
	type RuntimeMailboxMessage,
	type SupervisorRequest,
} from "../core/session-control-db.ts";

const REPLY_TYPE = "supervisor_question_reply";
const REPLY_MESSAGE_ID_PREFIX = "supervisor_question:";

/** Who answered: the Supervisor itself, or the user in the Supervisor session after an escalation. */
export type SupervisorQuestionAnswerSource = "supervisor" | "user";

export type SupervisorQuestionReply =
	| {
			type: typeof REPLY_TYPE;
			requestId: string;
			kind: "answer";
			source: SupervisorQuestionAnswerSource;
			answers: Record<string, string>;
			reasons: Record<string, string>;
	  }
	| { type: typeof REPLY_TYPE; requestId: string; kind: "escalate"; reason: string };

export type SupervisorQuestionReplyContent =
	| {
			kind: "answer";
			source: SupervisorQuestionAnswerSource;
			answers: Record<string, string>;
			reasons: Record<string, string>;
	  }
	| { kind: "escalate"; reason: string };

/** The asking session's key for one question: its session ID and the ask_questions tool-call ID. */
export function supervisorQuestionKey(askerSessionId: string, requestId: string): string {
	return `${askerSessionId}:${requestId}`;
}

/** The question key of a Supervisor reply message, or undefined for any other mailbox message. */
export function readSupervisorQuestionReplyKey(message: RuntimeMailboxMessage): string | undefined {
	const messageId = message.storeRef.messageId;
	if (!messageId.startsWith(REPLY_MESSAGE_ID_PREFIX)) return undefined;
	return messageId.slice(REPLY_MESSAGE_ID_PREFIX.length).replace(/:(answer|escalate)$/, "");
}

export function parseSupervisorQuestionReply(message: RuntimeMailboxMessage): SupervisorQuestionReply {
	const parsed: unknown = JSON.parse(message.body);
	if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || parsed.type !== REPLY_TYPE) {
		throw new Error(`Malformed Supervisor question reply ${message.storeRef.messageId}`);
	}
	return parsed as SupervisorQuestionReply;
}

/** The question's `requestId` from a `question` request payload. */
export function readQuestionRequestId(request: SupervisorRequest): string {
	const requestId = request.payload.requestId;
	if (typeof requestId !== "string" || !requestId) throw new Error(`Question request ${request.id} has no requestId`);
	return requestId;
}

/**
 * Sends a reply to the session that asked `request`. The message is stored in the Supervisor session's
 * mailbox store; at most one escalation and one answer exist per question.
 */
export function sendSupervisorQuestionReply(
	controlDbPath: string,
	supervisor: { sessionId: string; sessionPath: string },
	request: SupervisorRequest,
	content: SupervisorQuestionReplyContent,
): void {
	const requestId = readQuestionRequestId(request);
	const reply: SupervisorQuestionReply = { type: REPLY_TYPE, requestId, ...content };
	const messageId = `${REPLY_MESSAGE_ID_PREFIX}${supervisorQuestionKey(request.senderSessionId, requestId)}:${content.kind}`;
	enqueueStoredRuntimeMailboxMessage(controlDbPath, {
		kind: "reply",
		message: {
			body: JSON.stringify(reply),
			id: messageId,
			kind: "reply",
			status: "pending",
			fromAgentId: "main",
			toAgentId: "main",
		},
		recipient: { sessionId: request.senderSessionId, agentId: null },
		sender: { sessionId: supervisor.sessionId, agentId: null },
		storeRef: { messageId, sessionPath: supervisor.sessionPath },
	});
}
