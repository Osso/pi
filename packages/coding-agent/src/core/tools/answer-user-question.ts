import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { enqueueStoredRuntimeMailboxMessage, recordUserQuestionAnswer } from "../session-control-db.ts";

const answerUserQuestionSchema = Type.Object({
	id: Type.Number({ description: "The user question ID from the user question message." }),
	answer: Type.String({ description: "Your answer to the user's question." }),
});
const USER_QUESTION_STORE_PATH = "user-questions";

export type AnswerUserQuestionToolInput = Static<typeof answerUserQuestionSchema>;

export interface AnswerUserQuestionToolDetails {
	id: number;
	answer: string;
}

/**
 * Queues an answer for the question store on the Supervisor host; the relay there records it. Each
 * answer gets its own message ID, so a revision can be queued while an earlier answer is still in transit.
 */
export function sendRemoteUserQuestionAnswer(
	controlDbPath: string,
	supervisor: { sessionId: string; host: string },
	params: AnswerUserQuestionToolInput,
): void {
	const messageId = `user_question_answer:${hostname()}:${params.id}:${randomUUID()}`;
	enqueueStoredRuntimeMailboxMessage(controlDbPath, {
		kind: "message",
		recipientHost: supervisor.host,
		recipient: { sessionId: supervisor.sessionId, agentId: null },
		sender: { sessionId: "pi-questions", agentId: null },
		storeRef: { sessionPath: USER_QUESTION_STORE_PATH, messageId },
		message: {
			id: messageId,
			kind: "message",
			status: "pending",
			fromAgentId: "main",
			toAgentId: "main",
			body: JSON.stringify({ id: params.id, answer: params.answer }),
			createdAt: new Date().toISOString(),
		},
	});
}

export function createAnswerUserQuestionToolDefinition(): ToolDefinition<
	typeof answerUserQuestionSchema,
	AnswerUserQuestionToolDetails
> {
	return {
		name: "answer_user_question",
		label: "answer_user_question",
		description: "Record an answer to a question sent by the user.",
		promptSnippet: "Answer user questions with answer_user_question",
		parameters: answerUserQuestionSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			if (!params.answer.trim()) throw new Error("answer_user_question answer must be nonblank");
			const controlDbPath = ctx.controlDbPath;
			if (!controlDbPath) throw new Error("answer_user_question requires a control database");
			const supervisor = ctx.settingsManager?.getMergedSettings().supervisor ?? {};
			if (supervisor.host === undefined || supervisor.host === hostname()) {
				if (!recordUserQuestionAnswer(controlDbPath, params.id, params.answer)) {
					throw new Error(`Unknown user question ${params.id}`);
				}
			} else {
				if (!supervisor.sessionId) throw new Error("A Supervisor session is required for remote user questions");
				sendRemoteUserQuestionAnswer(
					controlDbPath,
					{ sessionId: supervisor.sessionId, host: supervisor.host },
					params,
				);
			}
			return {
				content: [{ type: "text", text: `Recorded answer to user question ${params.id}.` }],
				details: { id: params.id, answer: params.answer },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("answer_user_question"))} ${theme.fg("accent", String(args.id ?? ""))}`,
			);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("accent", `→ ${result.details?.answer ?? ""}`));
			return text;
		},
	};
}
