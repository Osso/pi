import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setKeybindings, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { QuestionListComponent } from "../src/cli/questions-list.ts";
import { QuestionsApp } from "../src/cli/questions-tui.ts";
import { runHostRelay } from "../src/core/host-relay.ts";
import { importRelayMailbox, nextRelayMailbox } from "../src/core/host-relay-store.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	listRuntimeMailboxListeners,
	postSupervisorRequest,
	readSessionHealth,
	registerRuntimeMailboxListener,
	takeRuntimeMailboxMessagesForDelivery,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { listSessions } from "../src/core/session-directory.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	lookupQuestionSessionNames,
	type QuestionCenter,
	type UserQuestionEntry,
} from "../src/questions/question-center.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const SUPERVISOR = "supervisor-session";
const REMOTE = "remote-worker-session";

function createEntry(host: string): UserQuestionEntry {
	return {
		direction: "user",
		ref: "u1",
		id: 1,
		createdAt: new Date().toISOString(),
		session: { sessionId: REMOTE, host },
		question: "What changed?",
		state: "answered",
		answer: "The configuration.",
	};
}

describe("question session names over the host relay", () => {
	let root: string;
	let sourceDb: string;
	let targetDb: string;
	const stops: Array<() => void> = [];

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		root = mkdtempSync(join(tmpdir(), "pi-question-session-names-"));
		sourceDb = join(root, "source.sqlite");
		targetDb = join(root, "target.sqlite");
		initTheme("dark");
	});

	afterEach(async () => {
		for (const stop of stops.splice(0)) stop();
		await new Promise((resolve) => setTimeout(resolve, 20));
		rmSync(root, { recursive: true, force: true });
	});

	it("imports a targeted name-only reply and renders the remote name", async () => {
		const now = new Date().toISOString();
		writeSessionMetadata(targetDb, {
			sessionPath: join(root, "intentionally-absent-transcript.jsonl"),
			id: REMOTE,
			cwd: "/srv/worker",
			name: "Billing worker",
			createdAt: now,
			modifiedAt: now,
			messageCount: 0,
			firstMessage: "",
		});
		writeSessionMetadata(targetDb, {
			sessionPath: join(root, "unrequested.jsonl"),
			id: "unrequested-session",
			cwd: "/srv/other",
			name: "Do not return",
			createdAt: now,
			modifiedAt: now,
			messageCount: 0,
			firstMessage: "",
		});
		registerRuntimeMailboxListener(sourceDb, { sessionId: SUPERVISOR, agentId: null }, process.pid);

		const sourceToTarget = new PassThrough();
		const targetToSource = new PassThrough();
		const controller = new AbortController();
		stops.push(() => controller.abort());
		const common = { pollMs: 20, signal: controller.signal };
		void runHostRelay({
			...common,
			controlDbPath: sourceDb,
			host: "store-host",
			input: targetToSource,
			output: sourceToTarget,
		});
		void runHostRelay({
			...common,
			controlDbPath: targetDb,
			host: "remote-host",
			input: sourceToTarget,
			output: targetToSource,
		});

		const entry = createEntry("remote-host");
		const names = await lookupQuestionSessionNames(
			{ controlDbPath: sourceDb, supervisorSessionId: SUPERVISOR } satisfies QuestionCenter,
			[entry],
		);

		expect(names.get(JSON.stringify(["remote-host", REMOTE]))).toBe("Billing worker");
		expect([...names.values()]).toEqual(["Billing worker"]);
		expect(listRuntimeMailboxListeners(sourceDb).map((listener) => listener.sessionId)).toEqual([SUPERVISOR]);
		expect(takeRuntimeMailboxMessagesForDelivery(targetDb, { sessionId: REMOTE, agentId: null }, () => true)).toEqual(
			[],
		);
		const component = new QuestionListComponent({
			heading: "Questions",
			notice: "",
			emptyText: "None",
			toggleLabel: "all questions",
			entries: [entry],
			sessionNames: names,
			now: Date.now(),
			actions: [],
			closingActions: [],
			onAction: () => {},
			onEntry: () => {},
			onCancel: () => {},
			onToggleAll: () => {},
		});
		const lines = component.render(160).map(stripAnsi);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(160);
		expect(lines.join("\n")).toContain("Billing worker");
	});

	it("does not use a name reply imported from a different host", async () => {
		const now = new Date().toISOString();
		writeSessionMetadata(targetDb, {
			sessionPath: join(root, "remote.jsonl"),
			id: REMOTE,
			cwd: "/srv/worker",
			name: "Billing worker",
			createdAt: now,
			modifiedAt: now,
			messageCount: 0,
			firstMessage: "",
		});
		const names = lookupQuestionSessionNames({ controlDbPath: sourceDb }, [createEntry("remote-host")]);
		const request = nextRelayMailbox(sourceDb, "remote-host");
		if (!request) throw new Error("Expected name request");
		importRelayMailbox(targetDb, "store-host", request, "remote-host");
		const reply = nextRelayMailbox(targetDb, "store-host");
		if (!reply) throw new Error("Expected name reply");
		importRelayMailbox(sourceDb, "other-host", reply, "store-host");
		expect(await names).toEqual(new Map());
	});

	it("keeps an honest host and short-ID fallback when the relay does not return a name", () => {
		const entry = createEntry("remote-host");
		const component = new QuestionListComponent({
			heading: "Questions",
			notice: "",
			emptyText: "None",
			toggleLabel: "all questions",
			entries: [entry],
			sessionNames: new Map(),
			now: Date.now(),
			actions: [],
			closingActions: [],
			onAction: () => {},
			onEntry: () => {},
			onCancel: () => {},
			onToggleAll: () => {},
		});
		expect(component.render(120).map(stripAnsi).join("\n")).toContain(`remote-host:${REMOTE.slice(0, 8)}`);
	});

	it("keeps a question detail open when a name lookup finishes", async () => {
		const now = new Date().toISOString();
		writeSessionMetadata(targetDb, {
			sessionPath: join(root, "intentionally-absent-transcript.jsonl"),
			id: REMOTE,
			cwd: "/srv/worker",
			name: "Billing worker",
			createdAt: now,
			modifiedAt: now,
			messageCount: 0,
			firstMessage: "",
		});
		postSupervisorRequest(sourceDb, {
			deadlineAt: "9999-12-31T23:59:59.999Z",
			kind: "question",
			payload: { blocking: true, questions: [{ question: "What changed?" }] },
			projectId: "pi",
			replyTo: { sessionId: REMOTE, agentId: null, requestId: "question-call", host: "remote-host" },
			senderSessionId: REMOTE,
		});
		const ui = new TUI(new VirtualTerminal(140, 40));
		const app = new QuestionsApp(ui, { controlDbPath: sourceDb, supervisorSessionId: SUPERVISOR }, () => {});
		app.showList();
		for (const key of ["j", "j", "\r"]) ui.getFocusedComponent()?.handleInput?.(key);

		const sourceToTarget = new PassThrough();
		const targetToSource = new PassThrough();
		const controller = new AbortController();
		stops.push(() => controller.abort());
		const common = { pollMs: 20, signal: controller.signal };
		void runHostRelay({
			...common,
			controlDbPath: sourceDb,
			host: "store-host",
			input: targetToSource,
			output: sourceToTarget,
		});
		void runHostRelay({
			...common,
			controlDbPath: targetDb,
			host: "remote-host",
			input: sourceToTarget,
			output: targetToSource,
		});
		await new Promise((resolve) => setTimeout(resolve, 1_200));

		const detail = ui.render(140).map(stripAnsi).join("\n");
		expect(detail).toContain("Question  What changed?");
		expect(detail).toContain("Session   remote-host:remote-worker-session");
		ui.stop();
	});

	it("keeps simultaneous name lookups out of session reconciliation and removes them on quit", async () => {
		for (const host of ["remote-host", "other-host"]) {
			postSupervisorRequest(sourceDb, {
				deadlineAt: "9999-12-31T23:59:59.999Z",
				kind: "question",
				payload: { blocking: true, questions: [{ question: "What changed?" }] },
				projectId: "pi",
				replyTo: { sessionId: REMOTE, agentId: null, requestId: `question-call-${host}`, host },
				senderSessionId: REMOTE,
			});
		}
		const ui = new TUI(new VirtualTerminal(140, 40));
		let finished = false;
		const app = new QuestionsApp(ui, { controlDbPath: sourceDb, supervisorSessionId: SUPERVISOR }, () => {
			finished = true;
		});
		app.showList();
		const temporaryRoutes = listRuntimeMailboxListeners(sourceDb).filter((listener) =>
			listener.sessionId.startsWith("pi-questions-"),
		);
		expect(temporaryRoutes).toHaveLength(2);
		listSessions(sourceDb);
		expect(listRuntimeMailboxListeners(sourceDb)).toEqual(temporaryRoutes);
		for (const route of temporaryRoutes) expect(readSessionHealth(sourceDb, route.sessionId)).toBeUndefined();
		const focusedBeforeQuit = ui.getFocusedComponent();
		focusedBeforeQuit?.handleInput?.("\x1b");
		await Promise.resolve();

		expect(finished).toBe(true);
		expect(
			listRuntimeMailboxListeners(sourceDb).some((listener) => listener.sessionId.startsWith("pi-questions-")),
		).toBe(false);
		for (const route of temporaryRoutes) expect(readSessionHealth(sourceDb, route.sessionId)).toBeUndefined();
		expect(ui.getFocusedComponent()).toBe(focusedBeforeQuit);
		ui.stop();
	});
});
