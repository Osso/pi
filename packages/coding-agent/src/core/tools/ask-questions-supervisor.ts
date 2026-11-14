import {
	cancelSubmittedSupervisorRequest,
	type SupervisorReply,
	submitSupervisorRequest,
	watchSupervisorReplies,
} from "../../supervisor/mail.ts";
import { DEFAULT_SUPERVISOR_KB_DIR, resolveSupervisorProjectForCwd } from "../../supervisor/project-resolver.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import type { AskQuestionsToolInput } from "./ask-questions.ts";

/** Questions wait for the Supervisor or the user, whichever answers first; they never expire. */
const NO_DEADLINE = "9999-12-31T23:59:59.999Z";
const WITHDRAWN_REASON = "The user answered the questions locally";

export type SupervisorQuestionReply =
	| {
			kind: "answer";
			answeredBy: "supervisor" | "user";
			answers: Record<string, string>;
			reasons: Record<string, string>;
	  }
	| { kind: "escalate"; reason: string };

export interface SupervisorQuestionHandle {
	/** Stops waiting for replies. */
	stop(): void;
	/** Cancels the submitted question because the user answered it locally, then stops waiting. */
	withdraw(): void;
}

function toQuestionReply(reply: SupervisorReply): SupervisorQuestionReply {
	const response = reply.response;
	if (response.kind !== "answer") {
		const reason = "reason" in response ? response.reason : `Unexpected Supervisor reply ${response.kind}`;
		return { kind: "escalate", reason };
	}
	const entries = Object.entries(response.answers);
	return {
		kind: "answer",
		answeredBy: reply.answeredBy ?? "supervisor",
		answers: Object.fromEntries(entries.map(([question, entry]) => [question, entry.answer])),
		reasons: Object.fromEntries(entries.map(([question, entry]) => [question, entry.reason])),
	};
}

/**
 * Submits the questions as a `question` Supervisor request when this main session has a configured
 * Supervisor session other than itself. Replies arrive in this session's mailbox and go to `onReply`.
 */
export function askSupervisorQuestions(
	ctx: ExtensionContext,
	requestId: string,
	params: AskQuestionsToolInput,
	onReply: (reply: SupervisorQuestionReply) => void,
): SupervisorQuestionHandle | undefined {
	const { sessionId: supervisorSessionId, host } = ctx.settingsManager?.getMergedSettings().supervisor ?? {};
	const controlDbPath = ctx.controlDbPath;
	const isMainSession = ctx.multiAgentAgentId === undefined && !ctx.multiAgentRequiresAgentId;
	if (!supervisorSessionId || !controlDbPath || !isMainSession) return undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	if (supervisorSessionId === sessionId) return undefined;
	const supervisor = { sessionId: supervisorSessionId, host };
	const route = { sessionId, agentId: null, requestId };
	const stop = watchSupervisorReplies(controlDbPath, route, (reply) => onReply(toQuestionReply(reply)));
	submitSupervisorRequest(controlDbPath, supervisor, {
		deadlineAt: NO_DEADLINE,
		kind: "question",
		payload: { blocking: params.blocking, questions: params.questions },
		projectId: resolveSupervisorProjectForCwd(ctx.cwd, process.env.PI_KB_DIR ?? DEFAULT_SUPERVISOR_KB_DIR),
		replyTo: route,
	});
	return {
		stop,
		withdraw() {
			stop();
			cancelSubmittedSupervisorRequest(controlDbPath, supervisor, route, WITHDRAWN_REASON);
		},
	};
}
