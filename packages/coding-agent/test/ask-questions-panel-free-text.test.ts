import { CURSOR_MARKER, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type AskQuestionsPanelQuestion,
	type AskQuestionsPanelResult,
	createAskQuestionsPanel,
} from "../src/core/tools/ask-questions-panel.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const KEY = {
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	left: "\x1b[D",
	right: "\x1b[C",
	down: "\x1b[B",
	clear: "\x15",
};

function setup(questions: AskQuestionsPanelQuestion[]) {
	const results: AskQuestionsPanelResult[] = [];
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const panel = createAskQuestionsPanel({
		questions,
		theme,
		keybindings,
		requestRender: () => {},
		done: (result) => results.push(result),
	});
	panel.focused = true;
	return {
		panel,
		results,
		text: () => stripAnsi(panel.render(80).join("\n")),
		press: (...keys: string[]) =>
			keys.forEach((key) => {
				panel.handleInput?.(key);
			}),
	};
}

const choice = { question: "Which?", options: [{ label: "A" }, { label: "B" }] };

describe("ask_questions panel free text", () => {
	beforeAll(() => initTheme("dark"));

	it("immediately renders a focused input without choices or Other", () => {
		const { panel, text, press, results } = setup([{ question: "Explain?" }]);
		expect(text()).toContain("Your answer:");
		expect(text()).not.toContain("Other");
		expect(text()).not.toContain("1.");
		expect(panel.render(80).join("\n")).toContain(CURSOR_MARKER);
		press("  Concrete answer  ", KEY.enter);
		expect(results).toEqual([{ answers: { "Explain?": "Concrete answer" }, cancelled: false }]);
	});

	it("keeps blank submissions in the input until a nonblank answer is entered", () => {
		const { press, results, text } = setup([{ question: "Explain?" }]);
		press(KEY.enter, "   ", KEY.enter);
		expect(results).toEqual([]);
		expect(text()).toContain("Your answer:");
		press("answer", KEY.enter);
		expect(results[0]).toEqual({ answers: { "Explain?": "answer" }, cancelled: false });
	});

	it("preserves drafts across navigation and allows editing on revisit", () => {
		const { press, results, text } = setup([{ question: "First?" }, { question: "Second?" }]);
		press("first", KEY.tab, "second", KEY.shiftTab);
		expect(text()).toContain("first");
		press(" revised", KEY.enter);
		expect(text()).toContain("second");
		press(KEY.enter, KEY.enter);
		expect(results).toEqual([{ answers: { "First?": "first revised", "Second?": "second" }, cancelled: false }]);
	});

	it("uses arrows to edit text instead of changing questions", () => {
		const { press, results, text } = setup([{ question: "First?" }, choice]);
		press("ac", KEY.left, "b", KEY.right, "d");
		expect(text()).toContain("abcd");
		press(KEY.enter, KEY.enter, KEY.enter);
		expect(results[0]).toEqual({ answers: { "First?": "abcd", "Which?": "A" }, cancelled: false });
	});

	it("blocks Submit when free text is unanswered or cleared", () => {
		const { press, results, text } = setup([{ question: "Explain?" }, choice]);
		press(KEY.tab, KEY.enter, KEY.enter);
		expect(results).toEqual([]);
		expect(text()).toContain("Answer every question to submit");
		press(KEY.shiftTab, KEY.shiftTab, "draft", KEY.clear, KEY.tab, KEY.tab, KEY.enter);
		expect(results).toEqual([]);
		press(KEY.shiftTab, KEY.shiftTab, "answer", KEY.enter, KEY.tab, KEY.enter);
		expect(results[0]).toEqual({ answers: { "Explain?": "answer", "Which?": "A" }, cancelled: false });
	});

	it("cancels directly from free text and returns nonblank partial answers", () => {
		const { press, results } = setup([{ question: "First?" }, { question: "Second?" }]);
		press("partial", KEY.tab, "   ", KEY.escape);
		expect(results).toEqual([{ answers: { "First?": "partial" }, cancelled: true }]);
	});

	it("cancels unanswered free text without inventing an answer", () => {
		const { press, results } = setup([{ question: "Explain?" }]);
		press(KEY.escape);
		expect(results).toEqual([{ answers: {}, cancelled: true }]);
	});

	it("preserves choice selection and Other escape behavior in mixed panels", () => {
		const { press, results, text } = setup([choice, { question: "Explain?" }]);
		press(KEY.down, KEY.down, KEY.enter, "discard", KEY.escape);
		expect(results).toEqual([]);
		expect(text()).toContain("Other");
		press(KEY.enter, KEY.clear, "custom", KEY.enter, "detail", KEY.enter, KEY.shiftTab, KEY.shiftTab);
		expect(text()).toContain("Other: custom");
		press(KEY.tab, KEY.tab, KEY.enter);
		expect(results[0]).toEqual({ answers: { "Which?": "custom", "Explain?": "detail" }, cancelled: false });
	});

	it("preserves multi-select toggling and optional empty selection", () => {
		const { press, results } = setup([{ ...choice, multiSelect: true }, { question: "Explain?" }]);
		press(KEY.enter, KEY.down, KEY.enter, KEY.tab, "detail", KEY.enter, KEY.enter);
		expect(results[0]).toEqual({ answers: { "Which?": "A, B", "Explain?": "detail" }, cancelled: false });
		const empty = setup([{ ...choice, multiSelect: true }, { question: "Explain?" }]);
		empty.press(KEY.tab, "detail", KEY.enter, KEY.enter);
		expect(empty.results[0]).toEqual({ answers: { "Which?": "", "Explain?": "detail" }, cancelled: false });
	});
});
