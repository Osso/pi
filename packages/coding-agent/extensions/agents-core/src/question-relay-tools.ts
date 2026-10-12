import { Type } from "typebox";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "../../../src/core/extensions/types.ts";
import type { RuntimeMailboxToolDelivery } from "../../../src/core/runtime-mailbox-acceptance.ts";
import { isActiveLifecycle, type MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import {
	enqueueStoredRuntimeMailboxMessage,
	type RuntimeMailboxAddress,
	type RuntimeMailboxMessage,
	takeRuntimeMailboxMessagesForDelivery,
} from "../../../src/core/session-control-db.ts";
import {
	type AskQuestionsToolDetails,
	type AskQuestionsToolInput,
	createAskQuestionsToolDefinition,
	validateQuestions,
} from "../../../src/core/tools/ask-questions.ts";
import type { ContactParentMessageParams } from "./mailbox-tools.ts";

const MAIN_THREAD_AGENT_ID = "main";
const ANSWER_POLL_INTERVAL_MS = 500;

interface QuestionRelayTransports {
	contactParent(
		params: ContactParentMessageParams,
		ctx: ExtensionContext,
	): AgentToolResult<{ message: { id: string; status: string } }>;
}

interface QuestionAnswer {
	type: "ask_questions_answer";
	requestId: string;
	answers: Record<string, string>;
	cancelled: boolean;
}

type ChildAskQuestionsDetails = AskQuestionsToolDetails & { runtimeMailboxDelivery?: RuntimeMailboxToolDelivery };

const answerQuestionSchema = Type.Object(
	{
		agentId: Type.String({ description: "Direct child agent that asked the questions." }),
		requestId: Type.String({ description: "requestId from the child's question message." }),
		answers: Type.Record(Type.String(), Type.String(), {
			description: "Answers keyed by exact question text. Omit unanswered questions.",
		}),
		cancelled: Type.Optional(
			Type.Boolean({ description: "True when declining to answer; the child receives a cancelled result." }),
		),
	},
	{ additionalProperties: false },
);

function answerMessageId(requestId: string): string {
	return `ask_questions:${requestId}`;
}

function isChildRuntime(ctx: ExtensionContext): boolean {
	return ctx.multiAgentAgentId !== undefined || ctx.multiAgentRequiresAgentId === true;
}

function formatQuestion(question: AskQuestionsToolInput["questions"][number], index: number): string {
	const header = question.header ? `[${question.header}] ` : "";
	const lines = [`${index + 1}. ${header}${question.question}`];
	if (!question.options) {
		lines.push("   Free-text answer.");
		return lines.join("\n");
	}
	const choice = question.multiSelect ? "Choose one or more (comma-separated)" : "Choose one";
	lines.push(`   ${choice}, or give another answer:`);
	for (const option of question.options) {
		lines.push(`   - ${option.label}${option.description ? ` — ${option.description}` : ""}`);
	}
	return lines.join("\n");
}

function formatParentQuestionRequest(agentId: string, requestId: string, params: AskQuestionsToolInput): string {
	const waiting = params.blocking ? "The child is blocked until you answer." : "The child continues meanwhile.";
	return [
		`Child agent ${agentId} asks (requestId: ${requestId}). ${waiting}`,
		`Reply with answer_question using agentId "${agentId}" and requestId "${requestId}", answers keyed by exact question text. Ask the user with ask_questions first when you cannot answer.`,
		"",
		...params.questions.map(formatQuestion),
	].join("\n");
}

function formatAnswers(answers: Record<string, string>): string {
	return Object.entries(answers)
		.map(([question, answer]) => `- ${question} → ${answer || "(no selection)"}`)
		.join("\n");
}

function parseQuestionAnswer(message: RuntimeMailboxMessage): QuestionAnswer {
	const parsed: unknown = JSON.parse(message.body);
	if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || parsed.type !== "ask_questions_answer")
		throw new Error(`Malformed question answer ${message.storeRef.messageId}`);
	return parsed as QuestionAnswer;
}

interface QuestionAnswerInbox {
	controlDbPath: string;
	recipient: RuntimeMailboxAddress;
}

function takeQuestionAnswer(inbox: QuestionAnswerInbox, requestId: string): RuntimeMailboxMessage | undefined {
	const messageId = answerMessageId(requestId);
	const isAnswer = (message: RuntimeMailboxMessage) => message.storeRef.messageId === messageId;
	return takeRuntimeMailboxMessagesForDelivery(inbox.controlDbPath, inbox.recipient, isAnswer, 1)[0];
}

function waitForQuestionAnswer(
	inbox: QuestionAnswerInbox,
	requestId: string,
	signal: AbortSignal | undefined,
): Promise<RuntimeMailboxMessage | undefined> {
	return new Promise((resolve, reject) => {
		const poll = () => {
			if (signal?.aborted) return finish(undefined);
			try {
				const message = takeQuestionAnswer(inbox, requestId);
				if (message) finish(message);
			} catch (error) {
				cleanup();
				reject(error);
			}
		};
		const timer = setInterval(poll, ANSWER_POLL_INTERVAL_MS);
		const onAbort = () => finish(undefined);
		const cleanup = () => {
			clearInterval(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (message: RuntimeMailboxMessage | undefined) => {
			cleanup();
			resolve(message);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		poll();
	});
}

function childQuestionResult(
	params: AskQuestionsToolInput,
	text: string,
	answer: Pick<QuestionAnswer, "answers" | "cancelled">,
	extra: Partial<ChildAskQuestionsDetails> = {},
): AgentToolResult<ChildAskQuestionsDetails> {
	return {
		content: [{ type: "text", text }],
		details: {
			blocking: params.blocking,
			questions: params.questions,
			answers: answer.answers,
			cancelled: answer.cancelled,
			metadata: params.metadata,
			...extra,
		},
	};
}

function sendQuestionsToParent(
	transports: QuestionRelayTransports,
	toolCallId: string,
	params: AskQuestionsToolInput,
	ctx: ExtensionContext,
): QuestionAnswerInbox {
	const agentId = ctx.multiAgentAgentId;
	const controlDbPath = ctx.controlDbPath;
	if (!agentId || !controlDbPath)
		throw new Error("ask_questions in a child agent requires its agent identity and control database");
	const message = formatParentQuestionRequest(agentId, toolCallId, params);
	const sent = transports.contactParent({ message, threadId: answerMessageId(toolCallId) }, ctx);
	const request = sent.details.message;
	if (!request.id || request.status === "failed") {
		const reason = sent.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		throw new Error(`Could not send questions to parent: ${reason}`);
	}
	return { controlDbPath, recipient: { agentId, sessionId: ctx.sessionManager.getSessionId() } };
}

function deliveredAnswerResult(
	params: AskQuestionsToolInput,
	inbox: QuestionAnswerInbox,
	delivered: RuntimeMailboxMessage,
): AgentToolResult<ChildAskQuestionsDetails> {
	const answer = parseQuestionAnswer(delivered);
	const outcome = answer.cancelled ? "cancelled" : "answered";
	const text = `Parent ${outcome} questions:\n${formatAnswers(answer.answers)}`;
	const runtimeMailboxDelivery = {
		controlDbPath: inbox.controlDbPath,
		messages: [{ id: delivered.id, storeRef: delivered.storeRef }],
	};
	return childQuestionResult(params, text, answer, { runtimeMailboxDelivery });
}

async function askParent(
	transports: QuestionRelayTransports,
	toolCallId: string,
	params: AskQuestionsToolInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<ChildAskQuestionsDetails>> {
	validateQuestions(params.questions);
	const inbox = sendQuestionsToParent(transports, toolCallId, params, ctx);
	if (!params.blocking) {
		const text = `Questions sent to parent (request ${toolCallId}). Continue independent work; the answer will arrive in your inbox.`;
		return childQuestionResult(params, text, { answers: {}, cancelled: false }, { queued: true, requestId: toolCallId });
	}
	const delivered = await waitForQuestionAnswer(inbox, toolCallId, signal);
	if (!delivered) return childQuestionResult(params, "Questions cancelled", { answers: {}, cancelled: true });
	return deliveredAnswerResult(params, inbox, delivered);
}

function createChildAwareAskQuestionsTool(transports: QuestionRelayTransports) {
	const userTool = createAskQuestionsToolDefinition();
	return {
		...userTool,
		promptGuidelines: [
			...(userTool.promptGuidelines ?? []),
			"In a child agent, ask_questions sends the questions to your parent agent, which answers or asks the user.",
		],
		async execute(
			toolCallId: string,
			params: AskQuestionsToolInput,
			signal: AbortSignal | undefined,
			onUpdate: Parameters<typeof userTool.execute>[3],
			ctx: ExtensionContext,
		) {
			if (!isChildRuntime(ctx)) return userTool.execute(toolCallId, params, signal, onUpdate, ctx);
			if (typeof params.blocking !== "boolean")
				throw new Error("ask_questions requires explicit blocking: true or false");
			return askParent(transports, toolCallId, params, signal, ctx);
		},
	};
}

interface AnswerQuestionParams {
	agentId: string;
	requestId: string;
	answers: Record<string, string>;
	cancelled?: boolean;
}

interface AnswerRoute {
	callerId: string;
	controlDbPath: string;
	recipient: RuntimeMailboxAddress;
	sessionPath: string;
	targetName: string;
}

function readAnswerRoute(store: MultiAgentStore, agentId: string, ctx: ExtensionContext): AnswerRoute {
	const callerId = ctx.multiAgentAgentId ?? (ctx.multiAgentRequiresAgentId ? undefined : MAIN_THREAD_AGENT_ID);
	const target = store.getAgent(agentId);
	const targetParentId = target?.parentId ?? MAIN_THREAD_AGENT_ID;
	if (!callerId || !target || targetParentId !== callerId)
		throw new Error(`Could not answer ${agentId}: not a direct child of this agent`);
	if (!isActiveLifecycle(target.lifecycle))
		throw new Error(`Could not answer ${agentId}: inactive (${target.lifecycle})`);
	const persistence = store.getPersistenceTarget();
	const recipientSessionId = target.transcript?.sessionId;
	if (!persistence || !recipientSessionId || persistence.controlDbPath !== ctx.controlDbPath)
		throw new Error(`Could not answer ${agentId}: runtime mailbox is unavailable`);
	return {
		callerId,
		controlDbPath: persistence.controlDbPath,
		recipient: { agentId: target.id, sessionId: recipientSessionId },
		sessionPath: persistence.sessionPath,
		targetName: target.displayName,
	};
}

function answerQuestion(
	store: MultiAgentStore,
	params: AnswerQuestionParams,
	ctx: ExtensionContext,
): AgentToolResult<{ agentId: string; requestId: string }> {
	const route = readAnswerRoute(store, params.agentId, ctx);
	const answer: QuestionAnswer = {
		type: "ask_questions_answer",
		requestId: params.requestId,
		answers: params.answers,
		cancelled: params.cancelled === true,
	};
	const messageId = answerMessageId(params.requestId);
	enqueueStoredRuntimeMailboxMessage(route.controlDbPath, {
		kind: "reply",
		message: {
			body: JSON.stringify(answer),
			id: messageId,
			kind: "reply",
			status: "pending",
			fromAgentId: route.callerId,
			toAgentId: params.agentId,
		},
		recipient: route.recipient,
		sender: { agentId: ctx.multiAgentAgentId ?? null, sessionId: ctx.sessionManager.getSessionId() },
		storeRef: { messageId, sessionPath: route.sessionPath },
	});
	return {
		content: [{ type: "text", text: `Answered ${route.targetName} (request ${params.requestId}).` }],
		details: { agentId: params.agentId, requestId: params.requestId },
	};
}

export function registerQuestionRelayTools(
	pi: ExtensionAPI,
	store: MultiAgentStore,
	transports: QuestionRelayTransports,
): void {
	pi.registerTool(createChildAwareAskQuestionsTool(transports));
	pi.registerTool(
		defineTool({
			name: "answer_question",
			label: "Answer Question",
			description:
				"Answer questions a direct child agent sent with ask_questions. A blocking child resumes with these answers as its ask_questions result.",
			approvalRequired: false,
			parameters: answerQuestionSchema,
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => answerQuestion(store, params, ctx),
		}),
	);
}
