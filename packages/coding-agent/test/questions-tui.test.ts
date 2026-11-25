import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { QuestionsApp } from "../src/cli/questions-tui.ts";
import { ENV_AGENT_DIR, ENV_STATE_DIR } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	postSupervisorRequest,
	recordUserQuestionAnswer,
} from "../src/core/session-control-db.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	type AgentQuestionEntry,
	answerAgentQuestion,
	type QuestionCenter,
	readQuestionEntry,
} from "../src/questions/question-center.ts";
import { askUserQuestion } from "../src/user-questions/ask.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const SUPERVISOR = "supervisor-session";
const RUNNER = "Which test runner should this project use?";
const LONG =
	"Should the release pipeline publish the Bun binaries before or after the npm packages, given that the smoke tests need both?";
const HEADERS = ["ref", "dir", "state", "age", "session", "question", "source", "answer"];

interface Row {
	ref: string;
	cells: Record<string, string>;
}

/** The expected start of each cell of the rows the fixture stores, by column header. */
const ROWS: Row[] = [
	{
		ref: "a1",
		cells: {
			dir: "\u2192 you",
			state: "answered",
			age: "now",
			session: "laptop:asker-00",
			question: "Which",
			source: "you",
			answer: "vitest",
		},
	},
	{
		ref: "a2",
		cells: { dir: "\u2192 you", state: "open", age: "now", session: "laptop:asker-00", question: "Should" },
	},
	{
		ref: "u1",
		cells: {
			dir: "you \u2192",
			state: "answered",
			age: "now",
			session: "laptop:worker-0",
			question: "Why",
			source: "Agent",
			answer: "A missing",
		},
	},
	{
		ref: "u2",
		cells: { dir: "you \u2192", state: "open", age: "now", session: "laptop:reviewer", question: "Which" },
	},
];

describe("pi questions list", () => {
	let root: string;
	let center: QuestionCenter;
	const savedEnv = { agent: process.env[ENV_AGENT_DIR], state: process.env[ENV_STATE_DIR] };
	const cleanups: Array<() => void> = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		root = mkdtempSync(join(tmpdir(), "pi-questions-tui-"));
		mkdirSync(join(root, "agent"));
		process.env[ENV_AGENT_DIR] = join(root, "agent");
		process.env[ENV_STATE_DIR] = join(root, "state");
		writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ supervisor: { sessionId: SUPERVISOR } }));
		center = { controlDbPath: getControlDbPath(), supervisorSessionId: SUPERVISOR };
		seedQuestions();
	});

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.useRealTimers();
		for (const [key, value] of [
			[ENV_AGENT_DIR, savedEnv.agent],
			[ENV_STATE_DIR, savedEnv.state],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	function escalate(question: string, requestId: string): void {
		const id = postSupervisorRequest(center.controlDbPath, {
			deadlineAt: "9999-12-31T23:59:59.999Z",
			kind: "question",
			payload: { blocking: true, questions: [{ question }] },
			projectId: "pi",
			replyTo: { sessionId: "asker-0011223344", agentId: null, requestId, host: "laptop" },
			senderSessionId: "asker-0011223344",
		});
		const claimed = claimNextSupervisorRequest(center.controlDbPath, "claim");
		completeSupervisorRequest(center.controlDbPath, id, claimed?.claimToken ?? "", {
			kind: "escalate",
			reason: "Tradeoff.",
		});
	}

	function seedQuestions(): void {
		escalate(RUNNER, "call-1");
		answerAgentQuestion(center, readQuestionEntry(center, "a1") as AgentQuestionEntry, { [RUNNER]: "vitest" });
		escalate(LONG, "call-2");
		askUserQuestion(center.controlDbPath, { sessionId: "worker-0123456789", host: "laptop" }, "Why did CI fail?");
		recordUserQuestionAnswer(
			center.controlDbPath,
			1,
			"A missing lockfile entry for the tui package after the merge.",
		);
		askUserQuestion(center.controlDbPath, { sessionId: "reviewer-abcdef", host: "laptop" }, "Which commit broke it?");
	}

	function start(width: number): { ui: TUI; finished: () => boolean } {
		const ui = new TUI(new VirtualTerminal(width, 40));
		let done = false;
		new QuestionsApp(ui, center, () => {
			done = true;
		}).showList();
		cleanups.push(() => {
			for (let attempt = 0; attempt < 4 && !done; attempt++) press(ui, "\x1b");
			ui.stop();
		});
		return { ui, finished: () => done };
	}

	function screen(ui: TUI, width: number): string[] {
		const lines = ui.render(width);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		return lines.map(stripAnsi);
	}

	function press(ui: TUI, ...keys: string[]): void {
		for (const key of keys) ui.getFocusedComponent()?.handleInput?.(key);
	}

	/** Asserts the header and each listed row start every column at the same offset. */
	function expectAlignedRows(lines: string[], refs: string[]): void {
		const header = lines.find((line) =>
			/^\s+ref\s+dir\s+state\s+age\s+session\s+question\s+source\s+answer\s*$/.test(line),
		);
		expect(header).toBeDefined();
		const offsets = Object.fromEntries(HEADERS.map((name) => [name, header?.indexOf(name) ?? -1]));
		for (const row of ROWS.filter((candidate) => refs.includes(candidate.ref))) {
			const line = lines.find((candidate) => candidate.slice(offsets.ref).startsWith(`${row.ref} `));
			expect(line, row.ref).toBeDefined();
			for (const [column, value] of Object.entries(row.cells)) {
				const offset = offsets[column] ?? -1;
				expect(line?.slice(offset).startsWith(value), `${row.ref} ${column} in "${line}"`).toBe(true);
				expect(line?.[offset - 1], `${row.ref} ${column} in "${line}"`).toBe(" ");
			}
		}
		const tableRefs = lines.filter((line) => /^\s+(\u2192 )?\s*[au]\d+\s/.test(line)).length;
		expect(tableRefs).toBe(refs.length);
	}

	for (const width of [80, 140]) {
		it(`lists unanswered questions in aligned columns at width ${width}, tab switches to all and back`, () => {
			const { ui } = start(width);

			let lines = screen(ui, width);
			expect(lines.join("\n")).toContain("Unanswered questions, newest first");
			expect(lines.join("\n")).toContain("tab all questions");
			expectAlignedRows(lines, ["a2", "u2"]);

			press(ui, "\t");
			lines = screen(ui, width);
			expect(lines.join("\n")).toContain("All questions, last three days, newest first");
			expectAlignedRows(lines, ["a1", "a2", "u1", "u2"]);
			const answered = lines.find((line) => line.includes("a1 "));
			expect(answered).toContain("you");
			expect(answered).toContain("vitest");
			const agentAnswer = lines.find((line) => line.includes("u1 "));
			expect(agentAnswer).toContain("Agent");
			expect(agentAnswer).toContain("A missing");

			press(ui, "\t");
			lines = screen(ui, width);
			expect(lines.join("\n")).toContain("Unanswered questions, newest first");
			expectAlignedRows(lines, ["a2", "u2"]);
		});
	}

	it("refreshes stored rows in place, preserves selection, and moves safely when the selected row is answered", async () => {
		vi.useFakeTimers();
		const { ui, finished } = start(140);
		for (let step = 0; step < 8; step++) {
			if (/^ \u2192 a2 /.test(screen(ui, 140).find((line) => line.startsWith(" \u2192 ")) ?? "")) break;
			press(ui, "j");
		}
		expect(screen(ui, 140).find((line) => line.startsWith(" \u2192 "))).toMatch(/^ \u2192 a2 /);

		escalate("A new question arrived while the list was open.", "call-3");
		await vi.advanceTimersByTimeAsync(2_000);
		let lines = screen(ui, 140);
		expect(lines.some((line) => line.startsWith(" \u2192 a2 "))).toBe(true);
		expect(lines.some((line) => line.startsWith("   a3 "))).toBe(true);

		answerAgentQuestion(center, readQuestionEntry(center, "a2") as AgentQuestionEntry, { [LONG]: "Use Node 24." });
		await vi.advanceTimersByTimeAsync(2_000);
		lines = screen(ui, 140);
		expect(lines.some((line) => line.startsWith(" a2 "))).toBe(false);
		expect(lines.find((line) => line.startsWith(" \u2192 "))).toContain("+ Ask a session a question");
		press(ui, "\r");
		expect(screen(ui, 140).join("\n")).toContain("Ask which session?");
		press(ui, "\x1b");
		const timersBeforeQuit = vi.getTimerCount();
		press(ui, "\x1b");

		expect(finished()).toBe(true);
		expect(vi.getTimerCount()).toBeLessThan(timersBeforeQuit);
	});

	it("does not auto-refresh all-history mode and keeps manual Refresh", async () => {
		vi.useFakeTimers();
		const { ui, finished } = start(140);
		press(ui, "\t");
		escalate("An all-history update.", "call-3");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(screen(ui, 140).join("\n")).not.toContain("An all-history update.");

		press(ui, "j", "\r");
		expect(screen(ui, 140).join("\n")).toContain("An all-history update.");
		press(ui, "\x1b");
		expect(finished()).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not refresh behind a detail view and stops the timer on quit", async () => {
		vi.useFakeTimers();
		const { ui, finished } = start(140);
		for (let step = 0; step < 8; step++) {
			if (/^ \u2192 a2 /.test(screen(ui, 140).find((line) => line.startsWith(" \u2192 ")) ?? "")) break;
			press(ui, "j");
		}
		press(ui, "\r");
		expect(screen(ui, 140).join("\n")).toContain(LONG);
		escalate("A hidden list update.", "call-3");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(screen(ui, 140).join("\n")).toContain(LONG);
		expect(screen(ui, 140).join("\n")).not.toContain("A hidden list update.");
		press(ui, "\x1b");
		expect(screen(ui, 140).join("\n")).toContain("A hidden list update.");
		press(ui, "\x1b");
		expect(finished()).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shows recorded Supervisor and local-user sources without attributing historical answers", () => {
		for (const answeredBy of ["supervisor", "local", undefined] as const) {
			const question = `Source example ${answeredBy ?? "historical"}`;
			const id = postSupervisorRequest(center.controlDbPath, {
				deadlineAt: "9999-12-31T23:59:59.999Z",
				kind: "question",
				payload: { questions: [{ question }] },
				projectId: "pi",
				senderSessionId: "asker-0011223344",
			});
			const claimed = claimNextSupervisorRequest(center.controlDbPath, "source-test");
			completeSupervisorRequest(center.controlDbPath, id, claimed?.claimToken ?? "", {
				kind: "answer",
				answers: { [question]: { answer: "yes", reason: "test" } },
				...(answeredBy ? { answeredBy } : {}),
			});
		}
		const { ui } = start(80);
		press(ui, "\t");
		for (const width of [80, 140]) {
			const lines = screen(ui, width);
			for (const [ref, source] of [
				["a3", "Supervisor"],
				["a4", "you"],
				["a5", "unknown"],
			]) {
				const line = lines.find((candidate) => candidate.trimStart().startsWith(`${ref} `));
				expect(line).toMatch(new RegExp(`\\s${source}\\s+yes\\s*$`));
			}
		}
	});

	it("clips the question and answer columns to the width and keeps the full text at a wide width", () => {
		const { ui } = start(140);
		press(ui, "\t");
		const wide = screen(ui, 140).join("\n");
		const narrow = screen(ui, 80).join("\n");
		expect(wide).toContain("A missing lockfile entry");
		expect(narrow).not.toContain("A missing lockfile entry");
		expect(narrow).toContain("\u2026");
	});

	it("moves the selection with j/k and the arrows, opens the detail view, and quits on escape", () => {
		const { ui, finished } = start(140);
		press(ui, "\t");
		const selected = () => screen(ui, 140).find((line) => line.startsWith(" \u2192 ")) ?? "";

		expect(selected()).toContain("+ Ask a session a question");
		press(ui, "j");
		expect(selected()).toContain("Refresh");
		press(ui, "k", "\x1b[B");
		expect(selected()).toContain("Refresh");
		for (let step = 0; step < 6 && !/^ \u2192 a1 /.test(selected()); step++) press(ui, "j");
		expect(selected()).toMatch(/^ \u2192 a1 /);

		press(ui, "\r");
		const detail = screen(ui, 140).join("\n");
		expect(detail).toContain(`Question  ${RUNNER}`);
		expect(detail).toContain("Answer    vitest");
		expect(detail).toContain("Source    user");
		expect(detail).toContain("Revise the answer");

		press(ui, "\x1b");
		expect(finished()).toBe(false);
		expect(screen(ui, 140).join("\n")).toContain("All questions, last three days, newest first");
		for (let step = 0; step < 8; step++) {
			const selectedRow = screen(ui, 140).find((line) => line.startsWith(" \u2192 ")) ?? "";
			if (/^ \u2192 u1 /.test(selectedRow)) break;
			press(ui, "j");
		}
		press(ui, "\r");
		const userQuestionDetail = screen(ui, 140).join("\n");
		expect(userQuestionDetail).toContain("Answer    A missing lockfile entry");
		expect(userQuestionDetail).toContain("Source    Agent");
		press(ui, "\x1b");
		press(ui, "\x1b");
		expect(finished()).toBe(true);
	});
});
