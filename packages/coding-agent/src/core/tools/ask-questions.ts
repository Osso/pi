import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import {
	type DesktopNotificationHandle,
	PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
	sendDesktopNotification,
} from "../desktop-notification.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
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
	options: Type.Array(questionOptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description:
			"Available choices for this question. Provide 2-4 distinct choices; the UI adds an Other option automatically.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set true to allow multiple answers instead of one mutually exclusive answer." }),
	),
});

const askQuestionsSchema = Type.Object({
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
}

async function askQuestions(
	ctx: ExtensionContext,
	questions: AskQuestionsToolInput["questions"],
): Promise<AskQuestionsPanelResult> {
	return ctx.ui.custom<AskQuestionsPanelResult>((tui, theme, keybindings, done) =>
		createAskQuestionsPanel({ questions, theme, keybindings, requestRender: () => tui.requestRender(), done }),
	);
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
		details: { questions: params.questions, answers: {}, cancelled: true, metadata: params.metadata },
		isError: true,
	};
}

function cancelledResult(params: AskQuestionsToolInput, answers: Record<string, string>) {
	return {
		content: [{ type: "text" as const, text: "Questions cancelled" }],
		details: { questions: params.questions, answers, cancelled: true, metadata: params.metadata },
	};
}

function answeredResult(params: AskQuestionsToolInput, answers: Record<string, string>) {
	return {
		content: [{ type: "text" as const, text: `User answered questions:\n${formatAnswers(answers)}` }],
		details: { questions: params.questions, answers, cancelled: false, metadata: params.metadata },
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

export function createAskQuestionsToolDefinition(): ToolDefinition<typeof askQuestionsSchema, AskQuestionsToolDetails> {
	return {
		name: "ask_questions",
		label: "ask_questions",
		description:
			"Ask the user multiple-choice questions to clarify requirements, gather preferences, or choose between approaches. Similar to Claude Code's AskUserQuestion tool.",
		promptSnippet: "Ask the user structured multiple-choice clarifying questions",
		promptGuidelines: [
			"Use ask_questions only in interactive TUI sessions when you need user preferences, requirement clarification, or a decision between approaches.",
			"Do not ask free-form clarifying questions in chat when ask_questions can present clear options.",
			"Provide 2-4 distinct options. Do not include an Other option; Pi adds it automatically.",
			"If you recommend an option, make it first and add '(Recommended)' to its label.",
		],
		parameters: askQuestionsSchema,
		approvalRequired: false,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI || ctx.mode !== "tui") return unavailableResult(params);
			validateQuestions(params.questions);
			const notification = notifyAskQuestionsWaiting(params.questions.length);
			try {
				const { answers, cancelled } = await askQuestions(ctx, params.questions);
				return cancelled ? cancelledResult(params, answers) : answeredResult(params, answers);
			} finally {
				closeAskQuestionsNotification(notification);
			}
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
