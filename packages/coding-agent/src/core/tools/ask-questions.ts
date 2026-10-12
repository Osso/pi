import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import {
	type DesktopNotificationHandle,
	PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
	sendDesktopNotification,
} from "../desktop-notification.ts";
import type { ExtensionContext, ExtensionUIContext, ToolDefinition } from "../extensions/types.ts";
import { enqueueStoredRuntimeMailboxMessage, type RuntimeMailboxAddress } from "../session-control-db.ts";
import { type AskQuestionsPanelResult, createAskQuestionsPanel } from "./ask-questions-panel.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_QUESTIONS = 4;
const ASK_QUESTIONS_NOTIFICATION_TITLE = "Pi question needs input";

const questionOptionSchema = Type.Object({
	label: Type.String({
		description: "Concise display text for this option. Should be unique within the question.",
	}),
	description: Type.Optional(
		Type.String({ description: "Optional explanation of this option's meaning or trade-offs." }),
	),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional preview content for compatibility with AskUserQuestion-style callers. Pi currently returns it in details but does not render a dedicated preview pane.",
		}),
	),
});

const questionSchema = Type.Object({
	question: Type.String({
		description: "The complete question to ask the user. Should be clear, specific, and end with a question mark.",
	}),
	header: Type.Optional(
		Type.String({
			description: "Very short label displayed in summaries. Examples: 'Auth', 'Library', 'Approach'.",
		}),
	),
	options: Type.Optional(
		Type.Array(questionOptionSchema, {
			minItems: MIN_OPTIONS,
			maxItems: MAX_OPTIONS,
			description:
				"Provide 2-4 distinct choices; Pi adds Other automatically. Omit options for a free-text question.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set true to allow multiple answers instead of one mutually exclusive answer." }),
	),
});

const askQuestionsSchema = Type.Object({
	blocking: Type.Boolean({
		description:
			"Required. True waits for answers; false queues questions and returns immediately, with answers delivered later to your inbox. Continue only work independent of unanswered questions.",
	}),
	questions: Type.Array(questionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "Questions to ask the user (1-4 questions).",
	}),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Optional metadata for callers. Not displayed to the user.",
		}),
	),
});

export type AskQuestionsToolInput = Static<typeof askQuestionsSchema>;

export interface AskQuestionsToolDetails {
	blocking: boolean;
	queued?: boolean;
	requestId?: string;
	questions: AskQuestionsToolInput["questions"];
	answers: Record<string, string>;
	cancelled: boolean;
	metadata?: Record<string, unknown>;
}

function validateQuestions(questions: AskQuestionsToolInput["questions"]): void {
	if (questions.length < 1 || questions.length > MAX_QUESTIONS) {
		throw new Error(`ask_questions requires 1-${MAX_QUESTIONS} questions`);
	}
	const questionTexts = new Set<string>();
	for (const question of questions) {
		if (questionTexts.has(question.question)) {
			throw new Error(`Duplicate question text: ${question.question}`);
		}
		questionTexts.add(question.question);
		validateQuestionOptions(question);
	}
}

function validateQuestionOptions(question: AskQuestionsToolInput["questions"][number]): void {
	if (question.options === undefined) {
		if (question.multiSelect) throw new Error(`Free-text question "${question.question}" cannot use multiSelect`);
		return;
	}
	if (question.options.length < MIN_OPTIONS || question.options.length > MAX_OPTIONS) {
		throw new Error(`Question "${question.question}" requires ${MIN_OPTIONS}-${MAX_OPTIONS} options`);
	}
	const optionLabels = new Set<string>();
	for (const option of question.options) {
		if (optionLabels.has(option.label)) {
			throw new Error(`Duplicate option label "${option.label}" in question "${question.question}"`);
		}
		optionLabels.add(option.label);
	}
}

const questionQueues = new WeakMap<ExtensionUIContext, Promise<void>>();

async function showQuestions(
	ui: ExtensionUIContext,
	questions: AskQuestionsToolInput["questions"],
): Promise<AskQuestionsPanelResult> {
	const notification = notifyAskQuestionsWaiting(questions.length);
	try {
		return await ui.custom<AskQuestionsPanelResult>((tui, theme, keybindings, done) =>
			createAskQuestionsPanel({ questions, theme, keybindings, requestRender: () => tui.requestRender(), done }),
		);
	} finally {
		closeAskQuestionsNotification(notification);
	}
}

function queueQuestions(
	ui: ExtensionUIContext,
	questions: AskQuestionsToolInput["questions"],
): Promise<AskQuestionsPanelResult> {
	const previous = questionQueues.get(ui) ?? Promise.resolve();
	const result = previous.then(() => showQuestions(ui, questions));
	// Each caller handles its own failure; a failed panel must not strand later requests.
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	questionQueues.set(ui, settled);
	void settled.then(() => {
		if (questionQueues.get(ui) === settled) questionQueues.delete(ui);
	});
	return result;
}

interface QuestionInboxTarget {
	controlDbPath: string;
	sessionPath: string;
	recipient: RuntimeMailboxAddress;
}

function captureQuestionInboxTarget(ctx: ExtensionContext): QuestionInboxTarget {
	const controlDbPath = ctx.controlDbPath;
	const sessionPath = ctx.sessionManager.getSessionFile();
	if (!controlDbPath || !sessionPath)
		throw new Error("Nonblocking ask_questions requires a persisted session and control database");
	return {
		controlDbPath,
		sessionPath,
		recipient: { sessionId: ctx.sessionManager.getSessionId(), agentId: ctx.multiAgentAgentId ?? null },
	};
}

function enqueueQuestionAnswer(target: QuestionInboxTarget, requestId: string, body: string): void {
	const messageId = `ask_questions:${requestId}`;
	const sender = { sessionId: target.recipient.sessionId, agentId: null };
	enqueueStoredRuntimeMailboxMessage(target.controlDbPath, {
		kind: "reply",
		message: {
			body,
			id: messageId,
			kind: "reply",
			status: "pending",
			fromAgentId: "main",
			toAgentId: target.recipient.agentId ?? "main",
		},
		recipient: target.recipient,
		sender,
		storeRef: { messageId, sessionPath: target.sessionPath },
	});
}

async function deliverQueuedAnswers(
	ui: ExtensionUIContext,
	target: QuestionInboxTarget,
	requestId: string,
	pending: Promise<AskQuestionsPanelResult>,
): Promise<void> {
	let body: string;
	try {
		const { answers, cancelled } = await pending;
		const title = cancelled
			? `Questions cancelled (request ${requestId})`
			: `User answered questions (request ${requestId}):`;
		body = `${title}\n${formatAnswers(answers)}`;
	} catch (error) {
		body = `Questions failed (request ${requestId}): ${error instanceof Error ? error.message : String(error)}`;
		ui.notify(body, "error");
	}
	try {
		enqueueQuestionAnswer(target, requestId, body);
	} catch (error) {
		const message = `Failed to deliver question answer (request ${requestId}): ${error instanceof Error ? error.message : String(error)}`;
		console.error(message);
		ui.notify(message, "error");
	}
}

function formatAnswers(answers: Record<string, string>): string {
	return Object.entries(answers)
		.map(([question, answer]) => `- ${question} → ${answer || "(no selection)"}`)
		.join("\n");
}

interface AskQuestionsRenderState {
	callText?: Text;
	details?: AskQuestionsToolDetails;
}

function formatQuestionAnswer(question: string, details: AskQuestionsToolDetails | undefined, theme: Theme): string {
	const line = `  ${theme.fg("toolOutput", question)}`;
	if (!details) return line;
	if (details.queued) return `${line} ${theme.fg("warning", "→ (queued)")}`;
	const answer = details.answers[question];
	if (answer === undefined) return `${line} ${theme.fg("warning", "→ (cancelled)")}`;
	return `${line} ${theme.fg("accent", `→ ${answer || "(no selection)"}`)}`;
}

// The call row carries the answers so they stay visible when tool output is hidden.
function formatAskQuestionsCall(
	args: AskQuestionsToolInput | undefined,
	details: AskQuestionsToolDetails | undefined,
	theme: Theme,
): string {
	const questions = args?.questions ?? [];
	const label = questions.length === 1 ? "1 question" : `${questions.length} questions`;
	const title = `${theme.fg("toolTitle", theme.bold("ask_questions"))} ${theme.fg("accent", label)}`;
	return [title, ...questions.map((question) => formatQuestionAnswer(question.question, details, theme))].join("\n");
}

function unavailableResult(params: AskQuestionsToolInput) {
	return {
		content: [{ type: "text" as const, text: "Error: ask_questions requires an interactive TUI session" }],
		details: {
			blocking: params.blocking,
			questions: params.questions,
			answers: {},
			cancelled: true,
			metadata: params.metadata,
		},
		isError: true,
	};
}

function cancelledResult(params: AskQuestionsToolInput, answers: Record<string, string>) {
	return {
		content: [{ type: "text" as const, text: "Questions cancelled" }],
		details: {
			blocking: params.blocking,
			questions: params.questions,
			answers,
			cancelled: true,
			metadata: params.metadata,
		},
	};
}

function answeredResult(params: AskQuestionsToolInput, answers: Record<string, string>) {
	return {
		content: [{ type: "text" as const, text: `User answered questions:\n${formatAnswers(answers)}` }],
		details: {
			blocking: params.blocking,
			questions: params.questions,
			answers,
			cancelled: false,
			metadata: params.metadata,
		},
	};
}

function formatAskQuestionsNotificationBody(questionCount: number): string {
	return questionCount === 1 ? "Pi is waiting for your answer." : "Pi is waiting for your answers.";
}

function notifyAskQuestionsWaiting(questionCount: number): DesktopNotificationHandle | undefined {
	try {
		return sendDesktopNotification({
			body: formatAskQuestionsNotificationBody(questionCount),
			expireTimeMs: PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
			title: ASK_QUESTIONS_NOTIFICATION_TITLE,
			urgency: "normal",
		});
	} catch (error) {
		console.error("Failed to send ask_questions desktop notification:", error);
		return undefined;
	}
}

function closeAskQuestionsNotification(notification: DesktopNotificationHandle | undefined): void {
	try {
		notification?.close();
	} catch (error) {
		console.error("Failed to close ask_questions desktop notification:", error);
	}
}

function startQueuedQuestionRequest(toolCallId: string, params: AskQuestionsToolInput, ctx: ExtensionContext) {
	const ui = ctx.ui;
	const target = captureQuestionInboxTarget(ctx);
	const pending = queueQuestions(ui, params.questions);
	void deliverQueuedAnswers(ui, target, toolCallId, pending).catch((error: unknown) => {
		console.error(`Failed question delivery handler (request ${toolCallId}):`, error);
	});
	return {
		content: [
			{
				type: "text" as const,
				text: `Questions queued (request ${toolCallId}). Continue independent work; answers will arrive in your inbox.`,
			},
		],
		details: {
			blocking: false,
			queued: true,
			requestId: toolCallId,
			questions: params.questions,
			answers: {},
			cancelled: false,
			metadata: params.metadata,
		},
	};
}

export function createAskQuestionsToolDefinition(): ToolDefinition<typeof askQuestionsSchema, AskQuestionsToolDetails> {
	return {
		name: "ask_questions",
		label: "ask_questions",
		description:
			"Ask the user questions with choices or free-text answers. Explicitly choose blocking to wait, or nonblocking to queue questions and receive answers through your inbox while work continues.",
		promptSnippet: "Ask all user questions through this tool; explicitly choose blocking or nonblocking",
		promptGuidelines: [
			"Use ask_questions only in interactive TUI sessions when you need user preferences, requirement clarification, or a decision between approaches.",
			"Always use ask_questions for questions to the user; never ask for user input in chat. Omit options for free-text questions.",
			"Always specify blocking explicitly. Use true when progress depends on the answer; use false to queue questions and continue independent authorized work. Nonblocking answers and cancellation arrive as inbox messages correlated by requestId.",
			"For multiple-choice questions, provide 2-4 distinct options. Do not include an Other option; Pi adds it automatically.",
			"If you recommend an option, make it first and add '(Recommended)' to its label.",
		],
		parameters: askQuestionsSchema,
		approvalRequired: false,
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (typeof params.blocking !== "boolean")
				throw new Error("ask_questions requires explicit blocking: true or false");
			if (!ctx.hasUI || ctx.mode !== "tui") return unavailableResult(params);
			validateQuestions(params.questions);
			if (!params.blocking) return startQueuedQuestionRequest(toolCallId, params, ctx);
			const { answers, cancelled } = await queueQuestions(ctx.ui, params.questions);
			return cancelled ? cancelledResult(params, answers) : answeredResult(params, answers);
		},
		renderCall(args, theme, context) {
			const state = context.state as AskQuestionsRenderState;
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			state.callText = text;
			text.setText(formatAskQuestionsCall(args, state.details, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const state = context.state as AskQuestionsRenderState;
			state.details = result.details;
			state.callText?.setText(formatAskQuestionsCall(context.args, state.details, theme));
			return (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		},
	};
}
