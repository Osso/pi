import { type Component, getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { getAgentDir } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { getControlDbPath } from "../core/session-control-db.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { createAskQuestionsPanel } from "../core/tools/ask-questions-panel.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import {
	type AgentQuestionEntry,
	answerAgentQuestion,
	askAgent,
	listAskTargets,
	listQuestionEntries,
	openQuestionCenter,
	panelQuestions,
	type QuestionCenter,
	type QuestionEntry,
	type SessionAddress,
	type UserQuestionEntry,
} from "../questions/question-center.ts";
import { runQuestionsControl } from "./questions-control.ts";
import { createStartupTui, startStartupTui } from "./startup-ui.ts";

/**
 * `pi questions`: an interactive view of the question store on this host. Answer or revise agent
 * questions, read agent answers, ask sessions new questions and follow-ups.
 */

const ASK_NEW = "+ Ask a session a question";
const REFRESH = "\u21bb Refresh";
const QUIT = "Quit";
const ASK_FOLLOW_UP = "Ask a follow-up";
const BACK = "Back";
const REVISE = "Revise the answer";
const ANSWER_LATE = "Answer it now (the asker gets your answer as a message)";
const MANUAL_TARGET = "Enter host:session-id";
const SUMMARY_WIDTH = 70;

function clip(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > SUMMARY_WIDTH ? `${line.slice(0, SUMMARY_WIDTH - 1)}\u2026` : line;
}

function chosenAnswers(entry: AgentQuestionEntry): string {
	return entry.questions.map((q) => entry.answers?.[q.question] ?? "?").join(" / ");
}

function summarize(entry: QuestionEntry): string {
	if (entry.direction === "user") return `${entry.ref} [${entry.state}] ${clip(`you: ${entry.question}`)}`;
	const text = entry.questions.map((q) => q.question).join(" / ");
	const state = entry.state === "answered" ? `answered: ${clip(chosenAnswers(entry))}` : entry.state;
	return `${entry.ref} [${state}] ${clip(text)}`;
}

function describeAddress(address: SessionAddress): string {
	return address.host ? `${address.host}:${address.sessionId}` : address.sessionId;
}

function describeUserQuestion(entry: UserQuestionEntry): string {
	const parent = entry.parentId === undefined ? "" : ` (follow-up to u${entry.parentId})`;
	const answer = entry.answer ?? "(no answer yet)";
	return `${entry.ref} to ${describeAddress(entry.session)}${parent}\n\nYou asked: ${entry.question}\n\nAnswer: ${answer}`;
}

function describeAnswerSource(entry: AgentQuestionEntry): string {
	if (!entry.answeredBy) return "";
	const revised = entry.revisedAt ? `, revised ${entry.revisedAt}` : "";
	return ` by ${entry.answeredBy}${revised}`;
}

function describeAgentQuestion(entry: AgentQuestionEntry): string {
	const lines = entry.questions.map(
		(q) => `- ${q.question}\n  \u2192 ${entry.answers?.[q.question] ?? "(no answer)"}`,
	);
	const head = `${entry.ref} from ${describeAddress(entry.session)} [${entry.state}${describeAnswerSource(entry)}]`;
	return `${head}\n\n${lines.join("\n")}`;
}

/** Unanswered: waiting for you, for the Supervisor, or for the asked agent. */
function isUnanswered(entry: QuestionEntry): boolean {
	return entry.state === "open" || entry.state === "supervisor";
}

/** The question list; `app.questions.toggleAll` switches between unanswered and all questions. */
class QuestionListComponent extends ExtensionSelectorComponent {
	private readonly onToggleAll: () => void;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		onToggleAll: () => void,
		ui: TUI,
	) {
		super(title, options, onSelect, onCancel, { tui: ui });
		this.onToggleAll = onToggleAll;
	}

	override handleInput(keyData: string): void {
		if (getKeybindings().matches(keyData, "app.questions.toggleAll")) this.onToggleAll();
		else super.handleInput(keyData);
	}
}

function parseManualTarget(value: string): SessionAddress {
	const trimmed = value.trim();
	const separator = trimmed.lastIndexOf(":");
	if (separator === -1) return { sessionId: trimmed };
	return { host: trimmed.slice(0, separator), sessionId: trimmed.slice(separator + 1) };
}

class QuestionsApp {
	private readonly ui: TUI;
	private readonly center: QuestionCenter;
	private readonly keybindings = KeybindingsManager.create();
	private readonly finish: () => void;
	private current: Component | undefined;
	private notice = "";
	private showAll = false;

	constructor(ui: TUI, center: QuestionCenter, finish: () => void) {
		this.ui = ui;
		this.center = center;
		this.finish = finish;
	}

	private show(component: Component): void {
		if (this.current) this.ui.removeChild(this.current);
		this.current = component;
		this.ui.addChild(component);
		this.ui.setFocus(component);
		this.ui.requestRender();
	}

	/** Runs a store action; its error, or its result, becomes the notice on the list. */
	private act(action: () => string): void {
		try {
			this.notice = action();
		} catch (error) {
			this.notice = `Error: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.showList();
	}

	private select(title: string, options: string[], onSelect: (option: string) => void, onCancel: () => void): void {
		this.show(new ExtensionSelectorComponent(title, options, onSelect, onCancel, { tui: this.ui }));
	}

	private input(title: string, onSubmit: (value: string) => void): void {
		const input = new ExtensionInputComponent(
			title,
			undefined,
			(value) => {
				input.dispose();
				onSubmit(value);
			},
			() => {
				input.dispose();
				this.showList();
			},
			{ tui: this.ui },
		);
		this.show(input);
	}

	showList(): void {
		const entries = listQuestionEntries(this.center).filter((entry) => this.showAll || isUnanswered(entry));
		const byLabel = new Map(entries.map((entry) => [summarize(entry), entry]));
		const heading = this.showAll
			? "All questions, last three days, newest first (tab: unanswered only)"
			: `Unanswered questions, newest first (tab: all questions)${entries.length === 0 ? "\n\nNothing is waiting." : ""}`;
		const title = [heading, this.notice].filter(Boolean).join("\n");
		this.notice = "";
		const list = new QuestionListComponent(
			title,
			[ASK_NEW, REFRESH, ...byLabel.keys(), QUIT],
			(option) => {
				if (option === ASK_NEW) return this.chooseTarget();
				if (option === QUIT) return this.finish();
				const entry = byLabel.get(option);
				if (!entry) return this.showList();
				if (entry.direction === "user") return this.showUserQuestion(entry);
				this.showAgentQuestion(entry);
			},
			this.finish,
			() => {
				this.showAll = !this.showAll;
				this.showList();
			},
			this.ui,
		);
		this.show(list);
	}

	private showAgentQuestion(entry: AgentQuestionEntry): void {
		if (entry.state === "open") {
			this.answerAgentQuestion(entry);
			return;
		}
		// An answered question shows its chosen answers first; revising is an explicit choice.
		const answerAction = { open: undefined, answered: REVISE, cancelled: ANSWER_LATE, supervisor: undefined }[
			entry.state
		];
		this.select(
			describeAgentQuestion(entry),
			answerAction ? [answerAction, BACK] : [BACK],
			(option) => (option === BACK ? this.showList() : this.answerAgentQuestion(entry)),
			() => this.showList(),
		);
	}

	private answerAgentQuestion(entry: AgentQuestionEntry): void {
		const panel = createAskQuestionsPanel({
			questions: panelQuestions(entry),
			theme,
			keybindings: this.keybindings,
			requestRender: () => this.ui.requestRender(),
			done: ({ answers, cancelled }) => {
				if (cancelled) return this.showList();
				this.act(() => `${answerAgentQuestion(this.center, entry, answers)} ${entry.ref}`);
			},
		});
		this.show(panel);
	}

	private showUserQuestion(entry: UserQuestionEntry): void {
		this.select(
			describeUserQuestion(entry),
			[ASK_FOLLOW_UP, BACK],
			(option) => {
				if (option === BACK) return this.showList();
				this.input(`Follow-up to ${entry.ref}`, (text) =>
					this.act(() => `asked ${askAgent(this.center, { followUpOf: entry }, text).ref}`),
				);
			},
			() => this.showList(),
		);
	}

	private chooseTarget(): void {
		const targets = listAskTargets(this.center);
		const byLabel = new Map(targets.map((target) => [target.label, target]));
		this.select(
			"Ask which session?",
			[...byLabel.keys(), MANUAL_TARGET],
			(option) => {
				const target = byLabel.get(option);
				if (target) return this.askTarget(target);
				this.input("Session (host:session-id, or session-id on this host)", (value) =>
					this.askTarget(parseManualTarget(value)),
				);
			},
			() => this.showList(),
		);
	}

	private askTarget(target: SessionAddress): void {
		this.input(`Question for ${describeAddress(target)}`, (text) =>
			this.act(() => `asked ${askAgent(this.center, target, text).ref}`),
		);
	}
}

/** Runs `pi questions` when `args` start with it; returns false for any other command. */
export async function handleQuestionsCommand(args: string[]): Promise<boolean> {
	if (args[0] === "control" && args[1] === "questions") {
		await runQuestionsControl(args.slice(2));
		return true;
	}
	if (args[0] !== "questions") return false;
	const settingsManager = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	const center = openQuestionCenter(settingsManager, getControlDbPath());
	const ui = await createStartupTui(settingsManager);
	await new Promise<void>((resolve) => {
		const app = new QuestionsApp(ui, center, () => {
			ui.stop();
			resolve();
		});
		app.showList();
		startStartupTui(ui, settingsManager);
	});
	return true;
}
