import { hostname } from "node:os";
import {
	type Component,
	getKeybindings,
	isKeyRepeat,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "../modes/interactive/components/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../modes/interactive/components/keybinding-hints.ts";
import { type ThemeColor, theme } from "../modes/interactive/theme/theme.ts";
import {
	type AgentQuestionEntry,
	type QuestionEntry,
	type SessionAddress,
	sessionNameKey,
} from "../questions/question-center.ts";

/**
 * The `pi questions` list: a table of questions in aligned columns that fit the render width,
 * followed by the quit row.
 */

const MAX_VISIBLE_ROWS = 10;
const GAP = "  ";
/** Left padding plus the selection marker. */
const ROW_PREFIX_WIDTH = 3;
const HEADERS = ["ref", "dir", "state", "age", "session", "question", "source", "answer"] as const;
const SESSION_COLUMN = 4;
const QUESTION_COLUMN = 5;
const SOURCE_COLUMN = 6;
const ANSWER_COLUMN = 7;
const SHORT_ID_LENGTH = 8;

const STATE_COLORS: Record<QuestionEntry["state"], ThemeColor> = {
	open: "warning",
	supervisor: "accent",
	answered: "success",
	cancelled: "muted",
};

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Time since `iso` in one unit: "now", "5m", "3h", "2d". */
export function formatAge(iso: string, now: number): string {
	const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** A local or resolved remote session name, else `host:short-id` or the short ID. */
function sessionLabel(session: SessionAddress, names: ReadonlyMap<string, string>): string {
	const remote = session.host !== undefined && session.host !== hostname();
	const name = remote
		? names.get(sessionNameKey(session))
		: names.get(sessionNameKey({ sessionId: session.sessionId }));
	if (name) return name;
	const shortId = session.sessionId.slice(0, SHORT_ID_LENGTH);
	return remote ? `${session.host}:${shortId}` : shortId;
}

function chosenAnswers(entry: AgentQuestionEntry): string {
	return entry.questions.map((q) => entry.answers?.[q.question] ?? "?").join(" / ");
}

function answerSource(entry: QuestionEntry): string {
	if (entry.state !== "answered") return "";
	if (entry.direction === "user") return "Agent";
	switch (entry.answeredBy) {
		case "user":
		case "local":
			return "you";
		case "supervisor":
			return "Supervisor";
		default:
			return "unknown";
	}
}

function questionCells(entry: QuestionEntry, names: ReadonlyMap<string, string>, now: number): string[] {
	const agent = entry.direction === "agent";
	const question = agent ? entry.questions.map((q) => q.question).join(" / ") : entry.question;
	const answer = agent ? (entry.answers ? chosenAnswers(entry) : "") : (entry.answer ?? "");
	return [
		entry.ref,
		agent ? "\u2192 you" : "you \u2192",
		entry.state,
		formatAge(entry.createdAt, now),
		sessionLabel(entry.session, names),
		oneLine(question),
		answerSource(entry),
		oneLine(answer),
	];
}

function widest(rows: string[][], column: number): number {
	return Math.max(...rows.map((cells) => visibleWidth(cells[column] ?? "")));
}

/** Column widths for `width`: ref to age fit their values, session and answer are capped, question takes the rest. */
function columnWidths(rows: string[][], width: number): number[] {
	const content = width - ROW_PREFIX_WIDTH;
	const widths = HEADERS.map((_, column) => widest(rows, column));
	widths[SESSION_COLUMN] = Math.min(widths[SESSION_COLUMN] ?? 0, Math.max(8, Math.floor(content * 0.2)));
	widths[SOURCE_COLUMN] = Math.min(widths[SOURCE_COLUMN] ?? 0, Math.max(10, Math.floor(content * 0.12)));
	widths[ANSWER_COLUMN] = Math.min(widths[ANSWER_COLUMN] ?? 0, Math.max(8, Math.floor(content * 0.2)));
	const others = widths.reduce((sum, value, column) => (column === QUESTION_COLUMN ? sum : sum + value), 0);
	widths[QUESTION_COLUMN] = Math.max(1, content - others - GAP.length * (HEADERS.length - 1));
	return widths;
}

/** Footer lines of whole hints, each line within `width`. */
function packHints(hints: string[], width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const hint of hints) {
		const extended = line ? `${line}${GAP}${hint}` : ` ${hint}`;
		const overflows = line !== "" && visibleWidth(extended) > width;
		if (overflows) lines.push(line);
		line = overflows ? ` ${hint}` : extended;
	}
	return [...lines, line];
}

export interface QuestionListOptions {
	heading: string;
	notice: string;
	/** Shown instead of the table when there are no entries. */
	emptyText: string;
	/** What `app.questions.toggleAll` switches to. */
	toggleLabel: string;
	entries: QuestionEntry[];
	sessionNames: ReadonlyMap<string, string>;
	now: number;
	onEntry: (entry: QuestionEntry) => void;
	onCancel: () => void;
	onToggleAll: () => void;
	onRefresh: () => void;
	onNewQuestion: () => void;
}

export class QuestionListComponent implements Component {
	private readonly options: QuestionListOptions;
	private rows: string[][];
	private readonly border = new DynamicBorder();
	private selectedIndex = 0;
	private scrollTop = 0;

	constructor(options: QuestionListOptions) {
		this.options = options;
		this.rows = this.buildRows();
	}

	updateSessionNames(names: ReadonlyMap<string, string>): void {
		this.options.sessionNames = names;
		this.rows = this.buildRows();
	}

	update(entries: QuestionEntry[], sessionNames: ReadonlyMap<string, string>, now: number): void {
		const selectedEntry = this.options.entries[this.selectedIndex];
		this.options.entries = entries;
		this.options.sessionNames = sessionNames;
		this.options.now = now;
		this.rows = this.buildRows();

		const selectedEntryIndex = selectedEntry ? entries.findIndex((entry) => entry.ref === selectedEntry.ref) : -1;
		this.selectedIndex = Math.max(0, selectedEntryIndex);
		this.scrollTop = Math.min(this.scrollTop, Math.max(0, this.rows.length - MAX_VISIBLE_ROWS));
		this.keepSelectedVisible();
	}

	private buildRows(): string[][] {
		return this.options.entries.map((entry) => questionCells(entry, this.options.sessionNames, this.options.now));
	}

	private move(delta: number): void {
		this.selectedIndex = Math.max(0, Math.min(this.rows.length - 1, this.selectedIndex + delta));
		this.keepSelectedVisible();
	}

	private keepSelectedVisible(): void {
		const row = this.selectedIndex;
		if (row < 0 || row >= this.rows.length) return;
		if (row < this.scrollTop) this.scrollTop = row;
		else if (row >= this.scrollTop + MAX_VISIBLE_ROWS) this.scrollTop = row - MAX_VISIBLE_ROWS + 1;
	}

	private confirm(): void {
		const entry = this.options.entries[this.selectedIndex];
		if (entry) this.options.onEntry(entry);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.questions.refresh")) this.options.onRefresh();
		else if (kb.matches(keyData, "app.questions.new")) this.options.onNewQuestion();
		else if (kb.matches(keyData, "app.questions.toggleAll")) this.options.onToggleAll();
		else if (kb.matches(keyData, "tui.select.up") || kb.matches(keyData, "app.questions.listUp")) this.move(-1);
		else if (kb.matches(keyData, "tui.select.down") || kb.matches(keyData, "app.questions.listDown")) this.move(1);
		else if (kb.matches(keyData, "tui.select.confirm")) this.confirm();
		else if (kb.matches(keyData, "tui.select.cancel") && !isKeyRepeat(keyData)) this.options.onCancel();
	}

	invalidate(): void {}

	private tableLine(cells: string[], widths: number[], colors: ThemeColor[], marker: string): string {
		const columns = cells.map((cell, column) =>
			theme.fg(colors[column] ?? "text", truncateToWidth(cell, widths[column] ?? 0, "\u2026", true)),
		);
		return ` ${marker}${columns.join(GAP)}`;
	}

	private rowColors(index: number): ThemeColor[] {
		const state = this.options.entries[index]?.state ?? "open";
		const selected = index === this.selectedIndex;
		const main: ThemeColor = selected ? "accent" : "text";
		return [main, "muted", STATE_COLORS[state], "muted", "muted", main, "muted", selected ? "accent" : "success"];
	}

	private renderTable(width: number): string[] {
		if (this.rows.length === 0) return [`   ${theme.fg("muted", this.options.emptyText)}`];
		const widths = columnWidths([[...HEADERS], ...this.rows], width);
		const lines = [
			this.tableLine(
				[...HEADERS],
				widths,
				HEADERS.map((): ThemeColor => "dim"),
				"  ",
			),
		];
		const end = Math.min(this.scrollTop + MAX_VISIBLE_ROWS, this.rows.length);
		for (let index = this.scrollTop; index < end; index++) {
			const selected = index === this.selectedIndex;
			const marker = selected ? theme.fg("accent", "\u2192 ") : "  ";
			lines.push(this.tableLine(this.rows[index] ?? [], widths, this.rowColors(index), marker));
		}
		if (this.scrollTop > 0 || end < this.rows.length) {
			lines.push(theme.fg("muted", `   ${this.scrollTop + 1}-${end} of ${this.rows.length}`));
		}
		return lines;
	}

	private renderNotice(width: number): string[] {
		const { notice } = this.options;
		if (!notice) return [];
		return new Text(theme.fg(notice.startsWith("Error:") ? "error" : "success", notice), 1, 0).render(width);
	}

	render(width: number): string[] {
		const hints = packHints(
			[
				rawKeyHint("\u2191\u2193", "navigate"),
				keyHint("tui.select.confirm", "select"),
				keyHint("app.questions.new", "new question"),
				keyHint("app.questions.refresh", "refresh"),
				keyHint("app.questions.toggleAll", this.options.toggleLabel),
				keyHint("tui.select.cancel", "quit"),
			],
			width,
		);
		const lines = [
			...this.border.render(width),
			"",
			...new Text(theme.fg("accent", theme.bold(this.options.heading)), 1, 0).render(width),
			...this.renderNotice(width),
			"",
			...this.renderTable(width),
			"",
			...hints,
			"",
			...this.border.render(width),
		];
		return lines.map((line) => truncateToWidth(line, width, "\u2026"));
	}
}
