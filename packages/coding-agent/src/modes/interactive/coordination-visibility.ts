import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { QueuedMessagePreview } from "../../core/agent-session.ts";

const MAILBOX_ENVELOPE =
	/^From:\n(?:- host: [^\n]+ \(reply with toHost and toSessionId\)\n)?(?:- session: [^\n]+\n)?- agent: [^\n]+\n\nMessage:\n/;

const PERIODIC_AUDIT_TAG = /^\[periodic-checks: [^\n]+\]$/;

/** The inbox reply to this session's own nonblocking ask_questions call: answered, cancelled or failed. */
const QUESTION_REPLY =
	/^(?:User|Supervisor) answered questions \(request [^\n]*\):|^Questions (?:cancelled|failed) \(request /;

function readQuestionReply(text: string): string | undefined {
	if (text.match(/^From:$/gm)?.length !== 1) return undefined;
	const body = text.replace(MAILBOX_ENVELOPE, "");
	if (body === text || !QUESTION_REPLY.test(body)) return undefined;
	// The request ID is a long tool call ID; the questions identify the call.
	return body.replace(/ \(request [^\n]*?\)(:?)/, "$1");
}

/**
 * Shows the answers to the user's own questions without the mailbox envelope, and a single delivered
 * periodic-checks audit report as its leading `[periodic-checks: …]` tag line only.
 */
export function compactCoordinationText(text: string, coordination: boolean): string {
	const questionReply = readQuestionReply(text);
	if (questionReply !== undefined) return questionReply;
	if (!coordination || text.match(/^From:$/gm)?.length !== 1) return text;
	const [tag] = text.replace(MAILBOX_ENVELOPE, "").split("\n", 1);
	return tag !== undefined && PERIODIC_AUDIT_TAG.test(tag) ? tag : text;
}

export function isCoordinationPreview(message: QueuedMessagePreview): boolean {
	return (
		message.customType === "shared_channel" ||
		(message.inputSource === "extension" && MAILBOX_ENVELOPE.test(message.text))
	);
}

export function isCoordinationMessage(message: AgentMessage): boolean {
	if (message.role === "custom") return message.customType === "shared_channel";
	if (message.role !== "user" || message.inputSource !== "extension") return false;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
	// Answers to the user's own questions stay visible when coordination messages are hidden.
	return MAILBOX_ENVELOPE.test(text) && readQuestionReply(text) === undefined;
}
