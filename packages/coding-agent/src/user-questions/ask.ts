import { enqueueStoredRuntimeMailboxMessage, postUserQuestion, readUserQuestion } from "../core/session-control-db.ts";
import { SettingsManager } from "../core/settings-manager.ts";

const USER_QUESTION_STORE_PATH = "user-questions";

export function askUserQuestion(
	controlDbPath: string,
	target: { sessionId: string; host?: string },
	question: string,
	parentId?: number,
): number {
	const parent = parentId === undefined ? undefined : readUserQuestion(controlDbPath, parentId);
	if (parentId !== undefined && !parent) throw new Error(`Unknown user question ${parentId}`);
	const deliveryTarget = parent
		? { sessionId: parent.targetSessionId, ...(parent.targetHost ? { host: parent.targetHost } : {}) }
		: target;
	const id = postUserQuestion(controlDbPath, {
		targetHost: deliveryTarget.host,
		targetSessionId: deliveryTarget.sessionId,
		question,
		parentId,
	});
	const supervisorSessionId = SettingsManager.create(process.cwd(), undefined, {
		projectTrusted: false,
	}).getMergedSettings().supervisor?.sessionId;
	const senderSessionId = supervisorSessionId ?? "pi-questions";
	const body = parent
		? `User follow-up question ${id} (to question ${parent.id}: "${parent.question}" → "${parent.answer ?? ""}"): ${question}`
		: `User question ${id}: ${question}`;
	const messageId = `user_question:${id}`;
	enqueueStoredRuntimeMailboxMessage(controlDbPath, {
		kind: "message",
		...(deliveryTarget.host ? { recipientHost: deliveryTarget.host } : {}),
		recipient: { sessionId: deliveryTarget.sessionId, agentId: null },
		sender: { sessionId: senderSessionId, agentId: null },
		storeRef: { sessionPath: USER_QUESTION_STORE_PATH, messageId },
		message: {
			id: messageId,
			kind: "message",
			status: "pending",
			fromAgentId: "main",
			toAgentId: "main",
			body: `${body}\nAnswer it with answer_user_question { id: ${id}, answer }.`,
			createdAt: new Date().toISOString(),
		},
	});
	return id;
}
