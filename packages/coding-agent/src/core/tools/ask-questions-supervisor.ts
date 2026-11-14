import { DEFAULT_SUPERVISOR_KB_DIR, resolveSupervisorProjectForCwd } from "../../supervisor/project-resolver.ts";
import {
	parseSupervisorQuestionReply,
	readSupervisorQuestionReplyKey,
	type SupervisorQuestionReply,
	supervisorQuestionKey,
} from "../../supervisor/question-reply.ts";
import { notifySupervisorRequest } from "../../supervisor/request-wake.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import {
	cancelSupervisorRequest,
	deliverRuntimeMailboxMessage,
	postSupervisorRequest,
	type RuntimeMailboxAddress,
	type RuntimeMailboxMessage,
	readRuntimeMailboxMessageForDelivery,
	takeRuntimeMailboxMessagesForDelivery,
} from "../session-control-db.ts";
import type { AskQuestionsToolInput } from "./ask-questions.ts";

/** Questions wait for the Supervisor or the user, whichever answers first; they never expire. */
const NO_DEADLINE = "9999-12-31T23:59:59.999Z";
const WITHDRAWN_REASON = "The user answered the questions locally";

interface PendingQuestion {
	controlDbPath: string;
	recipient: RuntimeMailboxAddress;
	onReply: (reply: SupervisorQuestionReply) => void;
}

/** Questions of this process that wait for a Supervisor reply, by question key. */
const pendingQuestions = new Map<string, PendingQuestion>();

export interface SupervisorQuestionHandle {
	/** Stops waiting for replies; later replies reach the model as ordinary inbox messages. */
	stop(): void;
	/** Cancels the queued question because the user answered it locally, then stops waiting. */
	withdraw(): void;
}

/**
 * Posts the questions as a `question` Supervisor request when this main session has a configured
 * Supervisor session other than itself. Replies arrive in this session's mailbox and go to `onReply`.
 */
export function askSupervisorQuestions(
	ctx: ExtensionContext,
	requestId: string,
	params: AskQuestionsToolInput,
	onReply: (reply: SupervisorQuestionReply) => void,
): SupervisorQuestionHandle | undefined {
	const supervisorSessionId = ctx.settingsManager?.getSupervisorSessionId();
	const controlDbPath = ctx.controlDbPath;
	const isMainSession = ctx.multiAgentAgentId === undefined && !ctx.multiAgentRequiresAgentId;
	if (!supervisorSessionId || !controlDbPath || !isMainSession) return undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	if (supervisorSessionId === sessionId) return undefined;
	const rowId = postSupervisorRequest(controlDbPath, {
		deadlineAt: NO_DEADLINE,
		kind: "question",
		payload: { requestId, blocking: params.blocking, questions: params.questions },
		projectId: resolveSupervisorProjectForCwd(ctx.cwd, process.env.PI_KB_DIR ?? DEFAULT_SUPERVISOR_KB_DIR),
		senderSessionId: sessionId,
	});
	notifySupervisorRequest(controlDbPath);
	const key = supervisorQuestionKey(sessionId, requestId);
	pendingQuestions.set(key, {
		controlDbPath,
		recipient: { sessionId, agentId: null },
		onReply,
	});
	updateSignalListener();
	takePendingReplies();
	const stop = () => {
		pendingQuestions.delete(key);
		updateSignalListener();
	};
	return {
		stop,
		withdraw() {
			stop();
			if (cancelSupervisorRequest(controlDbPath, rowId, sessionId, WITHDRAWN_REASON)) {
				notifySupervisorRequest(controlDbPath);
			}
		},
	};
}

/**
 * Hands a claimed mailbox message to its waiting question. Returns false when no question in this
 * process waits for it, so the reply reaches the model as an ordinary inbox message (for example
 * after a restart dropped the panel).
 */
export function deliverSupervisorQuestionReply(message: RuntimeMailboxMessage): boolean {
	const key = readSupervisorQuestionReplyKey(message);
	const pending = key ? pendingQuestions.get(key) : undefined;
	if (!pending) return false;
	pending.onReply(parseSupervisorQuestionReply(message));
	return true;
}

// The session drains its mailbox only between turns, so a blocking question takes its own replies
// when the mailbox signal arrives.
function takePendingReplies(): void {
	for (const pending of new Set(pendingQuestions.values())) {
		const isWaitedFor = (message: RuntimeMailboxMessage) => {
			const key = readSupervisorQuestionReplyKey(message);
			return key !== undefined && pendingQuestions.get(key)?.controlDbPath === pending.controlDbPath;
		};
		const messages = takeRuntimeMailboxMessagesForDelivery(pending.controlDbPath, pending.recipient, isWaitedFor);
		if (messages.length === 0) continue;
		for (const message of messages) {
			markDelivered(pending.controlDbPath, message);
			deliverSupervisorQuestionReply(message);
		}
	}
}

// The reply's content reaches the transcript through the ask_questions result or answer delivery.
function markDelivered(controlDbPath: string, message: RuntimeMailboxMessage): void {
	const snapshot = readRuntimeMailboxMessageForDelivery(controlDbPath, message.id);
	if (snapshot?.payloadValid) deliverRuntimeMailboxMessage(controlDbPath, message.id, snapshot.payloadData);
}

const onMailboxSignal = () => {
	try {
		takePendingReplies();
	} catch (error) {
		console.error("Failed to take Supervisor question replies:", error);
	}
};

function updateSignalListener(): void {
	const listening = process.listeners("SIGUSR2").includes(onMailboxSignal);
	if (pendingQuestions.size > 0 && !listening && process.platform !== "win32") process.on("SIGUSR2", onMailboxSignal);
	if (pendingQuestions.size === 0 && listening) process.off("SIGUSR2", onMailboxSignal);
}
