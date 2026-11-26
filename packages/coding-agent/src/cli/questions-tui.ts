import { hostname } from "node:os";
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
	listSessionNames,
	lookupQuestionSessionNames,
	openQuestionCenter,
	panelQuestions,
	type QuestionCenter,
	type QuestionEntry,
	type SessionAddress,
	sessionNameKey,
	type UserQuestionEntry,
} from "../questions/question-center.ts";
import { runQuestionsControl } from "./questions-control.ts";
import { formatAge, QuestionListComponent } from "./questions-list.ts";
import { createStartupTui, startStartupTui } from "./startup-ui.ts";

/**
 * `pi questions`: an interactive view of the question store on this host. Answer or revise agent
 * questions, read agent answers, ask sessions new questions and follow-ups.
 */

const QUIT = "Quit";
const ASK_FOLLOW_UP = "Ask a follow-up";
const BACK = "Back";
const REVISE = "Revise the answer";
const ANSWER_LATE = "Answer it now (the asker gets your answer as a message)";
const MANUAL_TARGET = "Enter host:session-id";

function describeAddress(address: SessionAddress): string {
	return address.host ? `${address.host}:${address.sessionId}` : address.sessionId;
}

/** One aligned `Label    value` line of a detail view. */
function field(label: string, value: string): string {
	return `${label.padEnd(10)}${value}`;
}

function askedField(entry: QuestionEntry): string {
	const at = entry.createdAt.slice(0, 16).replace("T", " ");
	return field("Asked", `${at} UTC (${formatAge(entry.createdAt, Date.now())} ago)`);
}

function describeUserQuestion(entry: UserQuestionEntry): string {
	const parent = entry.parentId === undefined ? [] : [field("Follow-up", `to u${entry.parentId}`)];
	return [
		`${entry.ref}  you \u2192  [${entry.state}]`,
		"",
		field("Question", entry.question),
		field("Answer", entry.answer ?? "(no answer yet)"),
		...(entry.state === "answered" ? [field("Source", "Agent")] : []),
		field("Session", describeAddress(entry.session)),
		...parent,
		askedField(entry),
	].join("\n");
}

function describeAnswerSource(entry: AgentQuestionEntry): string[] {
	if (entry.state !== "answered") return [];
	const source = entry.answeredBy ?? "unknown";
	const revised = entry.revisedAt ? `, revised ${entry.revisedAt}` : "";
	return [field("Source", `${source}${revised}`)];
}

function describeAgentQuestion(entry: AgentQuestionEntry): string {
	const pairs = entry.questions.flatMap((q) => [
		field("Question", q.question),
		field("Answer", entry.answers?.[q.question] ?? "(no answer)"),
	]);
	return [
		`${entry.ref}  \u2192 you  [${entry.state}]`,
		"",
		...pairs,
		...describeAnswerSource(entry),
		field("Session", describeAddress(entry.session)),
		askedField(entry),
	].join("\n");
}

/** Unanswered: waiting for you, for the Supervisor, or for the asked agent. */
function isUnanswered(entry: QuestionEntry): boolean {
	return entry.state === "open" || entry.state === "supervisor";
}

function parseManualTarget(value: string): SessionAddress {
	const trimmed = value.trim();
	const separator = trimmed.lastIndexOf(":");
	if (separator === -1) return { sessionId: trimmed };
	return { host: trimmed.slice(0, separator), sessionId: trimmed.slice(separator + 1) };
}

export class QuestionsApp {
	private readonly ui: TUI;
	private readonly center: QuestionCenter;
	private readonly keybindings = KeybindingsManager.create();
	private readonly finish: () => void;
	private current: Component | undefined;
	private currentList: QuestionListComponent | undefined;
	private notice = "";
	private showAll = false;
	private remoteNames = new Map<string, string>();
	private readonly remoteNamesAttempted = new Set<string>();
	private remoteNamesLoading = false;
	private remoteNamesController: AbortController | undefined;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private closed = false;

	constructor(ui: TUI, center: QuestionCenter, finish: () => void) {
		this.ui = ui;
		this.center = center;
		this.finish = finish;
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopRefreshTimer();
		this.remoteNamesController?.abort();
		this.finish();
	}

	private stopRefreshTimer(): void {
		if (this.refreshTimer === undefined) return;
		clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	private show(component: Component): void {
		this.stopRefreshTimer();
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

	showList(refreshNames = false): void {
		const allEntries = listQuestionEntries(this.center);
		const entries = allEntries.filter((entry) => this.showAll || isUnanswered(entry));
		this.loadRemoteNames(allEntries, refreshNames);
		const notice = this.notice;
		this.notice = "";
		const sessionNames = this.sessionNames();
		const list = new QuestionListComponent({
			heading: this.showAll ? "All questions, last three days, newest first" : "Unanswered questions, newest first",
			notice,
			emptyText: this.showAll ? "No questions in the last three days." : "Nothing is waiting.",
			toggleLabel: this.showAll ? "unanswered only" : "all questions",
			entries,
			sessionNames,
			now: Date.now(),
			closingActions: [QUIT],
			onAction: (action) => {
				if (action === QUIT) this.close();
			},
			onEntry: (entry) => {
				if (entry.direction === "user") return this.showUserQuestion(entry);
				this.showAgentQuestion(entry);
			},
			onCancel: () => this.close(),
			onToggleAll: () => {
				this.showAll = !this.showAll;
				this.showList();
			},
			onRefresh: () => this.reloadVisibleList(true),
			onNewQuestion: () => this.chooseTarget(),
		});
		this.currentList = list;
		this.show(list);
		if (!this.showAll) {
			this.refreshTimer = setInterval(() => this.reloadVisibleList(false), 2_000);
			this.refreshTimer.unref?.();
		}
	}

	private sessionNames(): Map<string, string> {
		const names = listSessionNames(this.center);
		for (const [key, name] of this.remoteNames) names.set(key, name);
		return names;
	}

	/** Reloads stored rows into the visible list in place, keeping its selection. */
	private reloadVisibleList(refreshNames: boolean): void {
		if (this.closed || this.current !== this.currentList || !this.currentList) return;
		const allEntries = listQuestionEntries(this.center);
		this.loadRemoteNames(allEntries, refreshNames);
		const entries = allEntries.filter((entry) => this.showAll || isUnanswered(entry));
		this.currentList.update(entries, this.sessionNames(), Date.now());
		this.ui.requestRender();
	}

	private newRemoteEntries(entries: QuestionEntry[]): QuestionEntry[] {
		const localHost = hostname();
		return entries.filter(
			({ session: { host, sessionId } }) =>
				Boolean(host) && host !== localHost && !this.remoteNamesAttempted.has(sessionNameKey({ host, sessionId })),
		);
	}

	private loadRemoteNames(entries: QuestionEntry[], refresh: boolean): void {
		if (this.closed || this.remoteNamesLoading) return;
		const requestedEntries = refresh ? entries : this.newRemoteEntries(entries);
		if (requestedEntries.length === 0) return;
		for (const entry of requestedEntries) {
			const { host, sessionId } = entry.session;
			if (host && host !== hostname()) this.remoteNamesAttempted.add(sessionNameKey({ host, sessionId }));
		}
		this.remoteNamesLoading = true;
		const controller = new AbortController();
		this.remoteNamesController = controller;
		void lookupQuestionSessionNames(this.center, requestedEntries, controller.signal).then(
			(names) => {
				this.remoteNamesLoading = false;
				this.remoteNamesController = undefined;
				if (this.closed) return;
				this.remoteNames = refresh ? names : new Map([...this.remoteNames, ...names]);
				if (this.current === this.currentList && this.currentList) {
					this.currentList.updateSessionNames(this.sessionNames());
					this.ui.requestRender();
					this.loadRemoteNames(listQuestionEntries(this.center), false);
				}
			},
			() => {
				this.remoteNamesLoading = false;
				this.remoteNamesController = undefined;
			},
		);
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
