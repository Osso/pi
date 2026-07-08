import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import {
	type DesktopNotificationHandle,
	NEVER_EXPIRE_DESKTOP_NOTIFICATION_MS,
	sendDesktopNotification,
} from "../desktop-notification.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_QUESTIONS = 4;
const OTHER_LABEL = "Other";
const DONE_LABEL = "Done";
const CANCEL_LABEL = "Cancel";
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

interface SelectionOption {
	label: string;
	value: string;
	custom: boolean;
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

function formatOption(option: AskQuestionsToolInput["questions"][number]["options"][number], index: number): string {
	const suffix = option.description ? ` — ${option.description}` : "";
	return `${index + 1}. ${option.label}${suffix}`;
}

function buildSelectionOptions(question: AskQuestionsToolInput["questions"][number]): SelectionOption[] {
	return [
		...question.options.map((option, index) => ({
			label: formatOption(option, index),
			value: option.label,
			custom: false,
		})),
		{ label: OTHER_LABEL, value: OTHER_LABEL, custom: true },
	];
}

async function askCustomAnswer(ctx: ExtensionContext, title: string): Promise<string | undefined> {
	const answer = await ctx.ui.input(title, "Type your answer");
	const trimmed = answer?.trim();
	return trimmed ? trimmed : undefined;
}

async function askSingleQuestion(
	ctx: ExtensionContext,
	question: AskQuestionsToolInput["questions"][number],
): Promise<string | undefined> {
	const options = buildSelectionOptions(question);
	const choice = await ctx.ui.select(question.question, [...options.map((option) => option.label), CANCEL_LABEL]);
	if (!choice || choice === CANCEL_LABEL) return undefined;
	const selected = options.find((option) => option.label === choice);
	if (!selected) return undefined;
	if (selected.custom) return askCustomAnswer(ctx, question.question);
	return selected.value;
}

function formatMultiSelectOption(option: SelectionOption, selected: ReadonlySet<string>): string {
	if (option.custom) return option.label;
	const marker = selected.has(option.value) ? "[x]" : "[ ]";
	return `${marker} ${option.label}`;
}

function readMultiSelectChoice(
	options: SelectionOption[],
	choice: string,
	selected: ReadonlySet<string>,
): SelectionOption | undefined {
	return options.find((option) => formatMultiSelectOption(option, selected) === choice);
}

function toggleSelectedOption(selected: Set<string>, value: string): void {
	if (selected.has(value)) {
		selected.delete(value);
		return;
	}
	selected.add(value);
}

async function applyMultiSelectChoice(
	ctx: ExtensionContext,
	question: AskQuestionsToolInput["questions"][number],
	option: SelectionOption,
	selected: Set<string>,
): Promise<void> {
	if (!option.custom) {
		toggleSelectedOption(selected, option.value);
		return;
	}
	const customAnswer = await askCustomAnswer(ctx, question.question);
	if (customAnswer) selected.add(customAnswer);
}

async function askMultiSelectQuestion(
	ctx: ExtensionContext,
	question: AskQuestionsToolInput["questions"][number],
): Promise<string | undefined> {
	const options = buildSelectionOptions(question);
	const selected = new Set<string>();
	for (;;) {
		const labels = options.map((option) => formatMultiSelectOption(option, selected));
		const choice = await ctx.ui.select(question.question, [...labels, DONE_LABEL, CANCEL_LABEL]);
		if (!choice || choice === CANCEL_LABEL) return undefined;
		if (choice === DONE_LABEL) return [...selected].join(", ");
		const option = readMultiSelectChoice(options, choice, selected);
		if (!option) return undefined;
		await applyMultiSelectChoice(ctx, question, option, selected);
	}
}

async function askQuestion(
	ctx: ExtensionContext,
	question: AskQuestionsToolInput["questions"][number],
): Promise<string | undefined> {
	return question.multiSelect ? askMultiSelectQuestion(ctx, question) : askSingleQuestion(ctx, question);
}

function formatAnswers(answers: Record<string, string>): string {
	return Object.entries(answers)
		.map(([question, answer]) => `- ${question} → ${answer || "(no selection)"}`)
		.join("\n");
}

function formatAskQuestionsCall(args: AskQuestionsToolInput | undefined, theme: Theme): string {
	const count = args?.questions.length ?? 0;
	const label = count === 1 ? "1 question" : `${count} questions`;
	return `${theme.fg("toolTitle", theme.bold("ask_questions"))} ${theme.fg("accent", label)}`;
}

function formatAskQuestionsResult(details: AskQuestionsToolDetails | undefined, theme: Theme): string {
	if (!details) return "";
	if (details.cancelled) return theme.fg("warning", "Questions cancelled");
	return theme.fg("toolOutput", `User answered:\n${formatAnswers(details.answers)}`);
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
			expireTimeMs: NEVER_EXPIRE_DESKTOP_NOTIFICATION_MS,
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
				const answers: Record<string, string> = {};
				for (const question of params.questions) {
					const answer = await askQuestion(ctx, question);
					if (answer === undefined) return cancelledResult(params, answers);
					answers[question.question] = answer;
				}
				return answeredResult(params, answers);
			} finally {
				closeAskQuestionsNotification(notification);
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatAskQuestionsCall(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatAskQuestionsResult(result.details, theme));
			return text;
		},
	};
}
