import {
	type Component,
	type Focusable,
	Input,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { KeybindingsManager } from "../keybindings.ts";

const OTHER_LABEL = "Other";

export interface AskQuestionsPanelQuestion {
	question: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}

export interface AskQuestionsPanelResult {
	answers: Record<string, string>;
	cancelled: boolean;
}

export interface AskQuestionsPanelOptions {
	questions: AskQuestionsPanelQuestion[];
	theme: Theme;
	keybindings: KeybindingsManager;
	requestRender: () => void;
	done: (result: AskQuestionsPanelResult) => void;
}

interface QuestionAnswer {
	selected: string[];
	custom?: string;
}

function formatAnswer(question: AskQuestionsPanelQuestion, answer: QuestionAnswer): string {
	if (!question.options || !question.multiSelect) return answer.custom ?? answer.selected[0] ?? "";
	const picked = question.options.map((option) => option.label).filter((label) => answer.selected.includes(label));
	return [...picked, ...(answer.custom ? [answer.custom] : [])].join(", ");
}

function hasAnswer(answer: QuestionAnswer): boolean {
	return answer.selected.length > 0 || answer.custom !== undefined;
}

function findFreeTextTabOffset(kb: KeybindingsManager, data: string): number {
	if (kb.matches(data, "app.questions.next") && !kb.matches(data, "tui.editor.cursorRight")) return 1;
	if (kb.matches(data, "app.questions.previous") && !kb.matches(data, "tui.editor.cursorLeft")) return -1;
	return 0;
}

function formatOptionMarker(multiSelect: boolean | undefined, selected: boolean): string {
	if (multiSelect) return selected ? "[x] " : "[ ] ";
	return selected ? "● " : "○ ";
}

function formatSingleLine(text: string): string {
	return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/** Tabbed question panel: one tab per question plus a Submit tab when more than one answer is collected. */
export function createAskQuestionsPanel(options: AskQuestionsPanelOptions): Component & Focusable {
	const { questions, theme, keybindings: kb, requestRender, done } = options;
	const answers = questions.map((): QuestionAnswer => ({ selected: [] }));
	const hasSubmitTab = questions.length > 1 || questions[0]?.multiSelect === true;
	const tabCount = questions.length + (hasSubmitTab ? 1 : 0);
	const cursors = questions.map(() => 0);
	const inputs = questions.map(() => new Input());
	let focused = false;
	let tab = 0;
	let editing = questions[0]?.options === undefined;
	let finished = false;

	const isSubmitTab = () => hasSubmitTab && tab === questions.length;
	function getQuestionState(index: number) {
		const question = questions[index];
		const answer = answers[index];
		if (!question || !answer) throw new Error(`Question state ${index} is missing`);
		return { question, answer };
	}
	const isFreeText = () => !isSubmitTab() && getQuestionState(tab).question.options === undefined;
	const canSubmit = () =>
		questions.every((question, index) => {
			const { answer } = getQuestionState(index);
			return (question.options !== undefined && question.multiSelect) || hasAnswer(answer);
		});

	function finish(cancelled: boolean): void {
		if (finished) return;
		finished = true;
		const collected: Record<string, string> = {};
		questions.forEach((question, index) => {
			const { answer } = getQuestionState(index);
			if (!cancelled || hasAnswer(answer)) collected[question.question] = formatAnswer(question, answer);
		});
		done({ answers: collected, cancelled });
	}

	function moveToTab(next: number): void {
		tab = Math.max(0, Math.min(tabCount - 1, next));
		editing = isFreeText();
	}

	function advanceAfterAnswer(): void {
		if (!hasSubmitTab) {
			finish(false);
			return;
		}
		moveToTab(tab + 1);
	}

	inputs.forEach((input, index) => {
		input.onSubmit = (value) => {
			const text = value.trim();
			const { answer, question } = getQuestionState(index);
			answer.custom = text || undefined;
			if (isFreeText() && !text) return;
			editing = false;
			if (!question.multiSelect && text) {
				answer.selected = [];
				advanceAfterAnswer();
			}
			requestRender();
		};
		input.onEscape = () => {
			if (isFreeText()) finish(true);
			else editing = false;
			requestRender();
		};
	});

	function activateRow(): void {
		const { question, answer } = getQuestionState(tab);
		const cursor = cursors[tab];
		const input = inputs[tab];
		if (cursor === undefined || !input) throw new Error(`Question controls ${tab} are missing`);
		const option = question.options?.[cursor];
		if (!option) {
			editing = true;
			input.setValue(answer.custom ?? "");
			return;
		}
		if (question.multiSelect) {
			answer.selected = answer.selected.includes(option.label)
				? answer.selected.filter((label) => label !== option.label)
				: [...answer.selected, option.label];
			return;
		}
		answers[tab] = { selected: [option.label] };
		advanceAfterAnswer();
	}

	function editAnswer(data: string): void {
		const freeText = isFreeText();
		const tabOffset = freeText ? findFreeTextTabOffset(kb, data) : 0;
		if (tabOffset !== 0) {
			moveToTab(tab + tabOffset);
			return;
		}
		const index = tab;
		const { answer } = getQuestionState(index);
		const input = inputs[index];
		if (!input) throw new Error(`Question input ${index} is missing`);
		input.handleInput(data);
		if (freeText) answer.custom = input.getValue().trim() || undefined;
	}

	function handleKey(data: string): void {
		if (editing) {
			editAnswer(data);
			return;
		}
		if (kb.matches(data, "app.questions.next")) moveToTab(tab + 1);
		else if (kb.matches(data, "app.questions.previous")) moveToTab(tab - 1);
		else if (kb.matches(data, "tui.select.cancel")) finish(true);
		else if (isSubmitTab()) {
			if (kb.matches(data, "tui.select.confirm") && canSubmit()) finish(false);
		} else if (kb.matches(data, "tui.select.up")) {
			const cursor = cursors[tab];
			if (cursor === undefined) throw new Error(`Question cursor ${tab} is missing`);
			cursors[tab] = Math.max(0, cursor - 1);
		} else if (kb.matches(data, "tui.select.down")) {
			const { question } = getQuestionState(tab);
			const cursor = cursors[tab];
			if (cursor === undefined) throw new Error(`Question cursor ${tab} is missing`);
			cursors[tab] = Math.min(question.options?.length ?? 0, cursor + 1);
		} else if (kb.matches(data, "tui.select.confirm")) activateRow();
	}

	function renderTabBar(width: number): string {
		const labels = questions.map((question, index) => {
			const { answer } = getQuestionState(index);
			const marker = hasAnswer(answer) ? "■" : "□";
			const text = ` ${marker} ${formatSingleLine(question.header ?? `Q${index + 1}`)} `;
			return index === tab ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg("muted", text);
		});
		const submitText = " ✓ Submit ";
		const submit = isSubmitTab()
			? theme.bg("selectedBg", theme.fg("text", submitText))
			: theme.fg(canSubmit() ? "success" : "dim", submitText);
		// Drop tabs from the left until the active tab fits, so a narrow terminal still shows it.
		const tabs = [...labels, submit];
		let first = 0;
		while (first < tab && visibleWidth(` … ${tabs.slice(first).join(" ")}`) > width) first++;
		return truncateToWidth(` ${first > 0 ? "… " : ""}${tabs.slice(first).join(" ")}`, width);
	}

	function renderOptionRows(width: number): string[] {
		const { question, answer } = getQuestionState(tab);
		const cursor = cursors[tab];
		if (cursor === undefined) throw new Error(`Question cursor ${tab} is missing`);
		if (!question.options) return [];
		const rows = question.options.map((option, index) => {
			const chosen = answer.selected.includes(option.label);
			const marker = formatOptionMarker(question.multiSelect, chosen);
			const description = option.description ? theme.fg("muted", ` — ${option.description}`) : "";
			return { text: `${marker}${index + 1}. ${option.label}${description}`, active: index === cursor };
		});
		const other = answer.custom === undefined ? OTHER_LABEL : `${OTHER_LABEL}: ${answer.custom}`;
		rows.push({ text: `${answer.custom === undefined ? "  " : "✎ "}${other}`, active: cursor === rows.length });
		return rows.map((row) => {
			const prefix = row.active ? theme.fg("accent", "> ") : "  ";
			const text = formatSingleLine(row.text);
			return truncateToWidth(` ${prefix}${row.active ? theme.fg("accent", text) : text}`, width);
		});
	}

	function renderSubmitSummary(width: number): string[] {
		const lines = questions.map((question, index) => {
			const { answer } = getQuestionState(index);
			const value = hasAnswer(answer) ? formatAnswer(question, answer) : theme.fg("warning", "—");
			return truncateToWidth(`   ${theme.fg("muted", `${formatSingleLine(question.question)} `)}→ ${value}`, width);
		});
		const status = canSubmit()
			? theme.fg("success", "Enter to submit")
			: theme.fg("warning", "Answer every question to submit");
		return [...lines, "", truncateToWidth(`   ${status}`, width)];
	}

	function renderBody(width: number): string[] {
		if (isSubmitTab()) return renderSubmitSummary(width);
		const { question } = getQuestionState(tab);
		const lines = wrapTextWithAnsi(theme.fg("text", question.question), Math.max(1, width - 2)).map(
			(line) => ` ${line}`,
		);
		lines.push("", ...renderOptionRows(width));
		if (editing) {
			const input = inputs[tab];
			if (!input) throw new Error(`Question input ${tab} is missing`);
			input.focused = focused;
			lines.push(
				"",
				truncateToWidth(` ${theme.fg("muted", "Your answer:")}`, width),
				...input.render(Math.max(1, width - 2)),
			);
		}
		return lines;
	}

	function renderHelp(): string {
		if (isFreeText()) return `${tabCount > 1 ? "Tab/Shift+Tab questions • " : ""}Enter save • Esc cancel`;
		if (editing) return "Enter save • Esc back";
		const navigation = tabCount > 1 ? "←→ questions • " : "";
		return `${navigation}↑↓ move • Enter ${questions[tab]?.multiSelect ? "toggle" : "select"} • Esc cancel`;
	}

	return {
		get focused() {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
		},
		handleInput(data: string): void {
			handleKey(data);
			requestRender();
		},
		invalidate(): void {},
		render(width: number): string[] {
			const rule = theme.fg("accent", "─".repeat(Math.max(1, width)));
			const tabBar = tabCount > 1 ? [renderTabBar(width), ""] : [];
			const help = truncateToWidth(` ${theme.fg("dim", renderHelp())}`, width);
			return [rule, ...tabBar, ...renderBody(width), "", help, rule];
		},
	};
}
