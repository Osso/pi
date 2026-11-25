import type { Component, TUI } from "@earendil-works/pi-tui";
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
const MANUAL_TARGET = "Enter host:session-id";
const SUMMARY_WIDTH = 70;

function clip(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > SUMMARY_WIDTH ? `${line.slice(0, SUMMARY_WIDTH - 1)}\u2026` : line;
}

function summarize(entry: QuestionEntry): string {
	const text =
		entry.direction === "user" ? `you: ${entry.question}` : entry.questions.map((q) => q.question).join(" / ");
	return `${entry.ref} [${entry.state}] ${clip(text)}`;
}

function describeAddress(address: SessionAddress): string {
	return address.host ? `${address.host}:${address.sessionId}` : address.sessionId;
}

function describeUserQuestion(entry: UserQuestionEntry): string {
	const parent = entry.parentId === undefined ? "" : ` (follow-up to u${entry.parentId})`;
	const answer = entry.answer ?? "(no answer yet)";
	return `${entry.ref} to ${describeAddress(entry.session)}${parent}\n\nYou asked: ${entry.question}\n\nAnswer: ${answer}`;
}

function describeAgentQuestion(entry: AgentQuestionEntry): string {
	const lines = entry.questions.map((q) => `- ${q.question} \u2192 ${entry.answers?.[q.question] ?? "(no answer)"}`);
	return `${entry.ref} from ${describeAddress(entry.session)} [${entry.state}]\n\n${lines.join("\n")}`;
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
		const entries = listQuestionEntries(this.center);
		const byLabel = new Map(entries.map((entry) => [summarize(entry), entry]));
		const title = ["Questions, last three days (newest first)", this.notice].filter(Boolean).join("\n");
		this.notice = "";
		this.select(
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
		);
	}

	private showAgentQuestion(entry: AgentQuestionEntry): void {
		if (entry.state !== "open" && entry.state !== "answered") {
			this.select(
				describeAgentQuestion(entry),
				[BACK],
				() => this.showList(),
				() => this.showList(),
			);
			return;
		}
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
