import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type Component, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import supervisorSessionExtension from "../../extensions/supervisor-session/src/index.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import {
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	listRuntimeMailboxMessages,
	postSupervisorRequest,
	readSupervisorRequest,
} from "../../src/core/session-control-db.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { sendSupervisorReply } from "../../src/supervisor/mail.ts";
import { answerQuestionAsUser, reviseQuestionAsUser } from "../../src/supervisor/question-answers.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
const QUESTION = "Which test runner should this project use?";
const ENTER = "\r";

interface PanelUi {
	ui: ExtensionUIContext;
	notices: string[];
	panels: Component[];
	closed: number;
}

/** A TUI context that opens real question panels; tests answer them by sending keys. */
function panelUi(): PanelUi {
	const state: PanelUi = { ui: undefined as unknown as ExtensionUIContext, notices: [], panels: [], closed: 0 };
	const custom = <T>(factory: (...args: unknown[]) => Component | Promise<Component>) =>
		new Promise<T>((resolve) => {
			const done = (value: T) => {
				state.closed += 1;
				resolve(value);
			};
			void Promise.resolve(factory({ requestRender: () => {} }, theme, new KeybindingsManager(), done)).then(
				(component) => state.panels.push(component),
			);
		});
	const notify = (message: string) => state.notices.push(message);
	state.ui = new Proxy({ custom, notify } as unknown as ExtensionUIContext, {
		get: (target, key) => (key in target ? target[key as keyof ExtensionUIContext] : () => undefined),
	});
	return state;
}

async function openSession(controlDbPath: string, ui?: PanelUi, supervisorSessionId?: string): Promise<Harness> {
	const harness = await createHarness({
		controlDbPath,
		extensionFactories: [supervisorSessionExtension],
		persistedSession: true,
	});
	harnesses.push(harness);
	const sessionId = supervisorSessionId ?? harness.sessionManager.getSessionId();
	harness.settingsManager.applyOverrides({ supervisor: { sessionId } });
	await harness.session.bindExtensions(ui ? { mode: "tui", uiContext: ui.ui } : { mode: "rpc" });
	return harness;
}

async function openSupervisor(controlDbPath: string, ui?: PanelUi): Promise<Harness> {
	const supervisor = await openSession(controlDbPath, ui);
	// The first turn persists the session file that question replies are stored against.
	supervisor.setResponses([fauxAssistantMessage("Ready.")]);
	await supervisor.session.prompt("Start.");
	return supervisor;
}

function askCall(blocking: boolean) {
	return fauxAssistantMessage(
		[
			fauxToolCall("ask_questions", {
				blocking,
				questions: [{ question: QUESTION, options: [{ label: "vitest" }, { label: "jest" }] }],
			}),
		],
		{ stopReason: "toolUse" },
	);
}

function supervisorResponse(args: Record<string, unknown>) {
	return fauxAssistantMessage([fauxToolCall("supervisor_response", args)], { stopReason: "toolUse" });
}

function askResult(harness: Harness) {
	const result = harness.session.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "ask_questions",
	);
	if (!result || result.role !== "toolResult") throw new Error("No ask_questions result");
	return result;
}

function resultText(harness: Harness): string {
	return askResult(harness)
		.content.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

function inboxText(harness: Harness): string {
	return harness.session.messages
		.flatMap((message) =>
			message.role === "user" && Array.isArray(message.content)
				? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				: [],
		)
		.join("\n");
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function requestStatuses(controlDbPath: string): string[] {
	const statuses: string[] = [];
	for (let id = 1; ; id++) {
		const request = readSupervisorRequest(controlDbPath, id);
		if (!request) return statuses;
		statuses.push(request.status);
	}
}

function sharedControlDb(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-sq-"));
	directories.push(directory);
	return getControlDbPath(directory);
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Supervisor question answering", () => {
	it("closes the local panel with the Supervisor's answer and reason", async () => {
		const controlDbPath = sharedControlDb();
		const supervisor = await openSupervisor(controlDbPath);
		supervisor.setResponses([
			supervisorResponse({
				kind: "answer",
				answers: { [QUESTION]: { answer: "vitest", reason: "AGENTS.md names vitest" } },
			}),
		]);
		const askerUi = panelUi();
		const asker = await openSession(controlDbPath, askerUi, supervisor.sessionManager.getSessionId());
		asker.setResponses([askCall(true), fauxAssistantMessage("Using vitest.")]);

		await asker.session.prompt("Pick a runner.");

		expect(resultText(asker)).toContain("Supervisor answered questions:");
		expect(resultText(asker)).toContain("vitest (Supervisor: AGENTS.md names vitest)");
		expect(askResult(asker).details).toMatchObject({ answeredBy: "supervisor", cancelled: false });
		expect(askerUi.closed).toBe(1);
		expect(requestStatuses(controlDbPath)).toEqual(["completed"]);
		expect(readSupervisorRequest(controlDbPath, 1)?.response).toMatchObject({
			kind: "answer",
			answeredBy: "supervisor",
		});
	});

	it("returns the answer the Supervisor gives after an automatic retry", async () => {
		const controlDbPath = sharedControlDb();
		const supervisor = await openSupervisor(controlDbPath);
		supervisor.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } });
		supervisor.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out." }),
			supervisorResponse({ kind: "answer", answers: { [QUESTION]: { answer: "vitest", reason: "Retried." } } }),
		]);
		const askerUi = panelUi();
		const asker = await openSession(controlDbPath, askerUi, supervisor.sessionManager.getSessionId());
		asker.setResponses([askCall(true), fauxAssistantMessage("Using vitest.")]);

		await asker.session.prompt("Pick a runner.");

		expect(resultText(asker)).toContain("vitest (Supervisor: Retried.)");
		expect(requestStatuses(controlDbPath)).toEqual(["completed"]);
	});

	it("withdraws the queued question when the user answers locally first", async () => {
		const controlDbPath = sharedControlDb();
		const askerUi = panelUi();
		const asker = await openSession(controlDbPath, askerUi, "supervisor-not-running");
		asker.setResponses([askCall(true), fauxAssistantMessage("Using vitest.")]);

		const turn = asker.session.prompt("Pick a runner.");
		await waitFor(() => askerUi.panels.length === 1);
		askerUi.panels[0]?.handleInput?.(ENTER);
		await turn;

		expect(resultText(asker)).toContain("User answered questions:");
		expect(askResult(asker).details).toMatchObject({ answers: { [QUESTION]: "vitest" }, cancelled: false });
		expect(requestStatuses(controlDbPath)).toEqual(["cancelled"]);
		expect(readSupervisorRequest(controlDbPath, 1)?.response).toMatchObject({
			kind: "answer",
			answeredBy: "local",
			answers: { [QUESTION]: { answer: "vitest" } },
		});
	});

	it("escalates to a panel in the Supervisor UI and returns the user's answer there", async () => {
		const controlDbPath = sharedControlDb();
		const supervisorUi = panelUi();
		const supervisor = await openSupervisor(controlDbPath, supervisorUi);
		supervisor.setResponses([supervisorResponse({ kind: "escalate", reason: "This is a product tradeoff." })]);
		const askerUi = panelUi();
		const asker = await openSession(controlDbPath, askerUi, supervisor.sessionManager.getSessionId());
		asker.setResponses([askCall(true), fauxAssistantMessage("Using vitest.")]);

		const turn = asker.session.prompt("Pick a runner.");
		await waitFor(() => supervisorUi.panels.length === 1);
		await waitFor(() => askerUi.notices.some((notice) => notice.includes("This is a product tradeoff.")));
		supervisorUi.panels[0]?.handleInput?.(ENTER);
		await turn;

		expect(resultText(asker)).toContain("User answered questions:");
		expect(askResult(asker).details).toMatchObject({ answers: { [QUESTION]: "vitest" }, answeredBy: "user" });
		expect(askerUi.closed).toBe(1);
	});

	it("closes the escalated panel without a reply when the user answers locally first", async () => {
		const controlDbPath = sharedControlDb();
		const supervisorUi = panelUi();
		const supervisor = await openSupervisor(controlDbPath, supervisorUi);
		supervisor.setResponses([supervisorResponse({ kind: "escalate", reason: "This is a product tradeoff." })]);
		const askerUi = panelUi();
		const asker = await openSession(controlDbPath, askerUi, supervisor.sessionManager.getSessionId());
		asker.setResponses([askCall(true), fauxAssistantMessage("Using vitest.")]);

		const turn = asker.session.prompt("Pick a runner.");
		// Generous bounds: the Supervisor's escalation is a model turn, slow under a loaded test run.
		await waitFor(() => supervisorUi.panels.length === 1 && askerUi.panels.length === 1, 20_000);
		askerUi.panels[0]?.handleInput?.(ENTER);
		await turn;
		await waitFor(() => supervisorUi.closed === 1, 20_000);

		expect(askResult(asker).details).toMatchObject({ answers: { [QUESTION]: "vitest" }, cancelled: false });
		expect(askResult(asker).details).not.toHaveProperty("answeredBy");
		expect(requestStatuses(controlDbPath)).toEqual(["cancelled"]);
		const mail = asker.session.messages.filter(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("supervisor_response"),
		);
		expect(mail).toEqual([]);
	}, 45_000);

	it("drops an escalation that arrives after a local answer but delivers a late answer", async () => {
		const controlDbPath = sharedControlDb();
		const askerUi = panelUi();
		const asker = await openSession(controlDbPath, askerUi, "test-supervisor");
		asker.setResponses([askCall(true), fauxAssistantMessage("Using vitest."), fauxAssistantMessage("Noted.")]);
		const turn = asker.session.prompt("Pick a runner.");
		await waitFor(() => askerUi.panels.length === 1);
		askerUi.panels[0]?.handleInput?.(ENTER);
		await turn;
		const route = {
			sessionId: asker.sessionManager.getSessionId(),
			agentId: null,
			requestId: askResult(asker).toolCallId,
		};

		const reply = (response: Parameters<typeof sendSupervisorReply>[3]["response"]) =>
			sendSupervisorReply(controlDbPath, "test-supervisor", route, { requestKind: "question", response });
		reply({ kind: "escalate", reason: "Late escalation." });
		reply({ kind: "answer", answers: { [QUESTION]: { answer: "jest", reason: "Late answer." } } });
		await waitFor(() => inboxText(asker).includes("Late answer."));

		expect(inboxText(asker)).not.toContain("Late escalation.");
	});

	it("delivers a late escalation of a question that was not answered locally", async () => {
		const controlDbPath = sharedControlDb();
		const asker = await openSession(controlDbPath, undefined, "test-supervisor");
		asker.setResponses([fauxAssistantMessage("Ready."), fauxAssistantMessage("Noted.")]);
		await asker.session.prompt("Start.");
		// A panel lost to a restart: the question is unresolved and nothing waits for its reply.
		const route = { sessionId: asker.sessionManager.getSessionId(), agentId: null, requestId: "lost-panel" };

		sendSupervisorReply(controlDbPath, "test-supervisor", route, {
			requestKind: "question",
			response: { kind: "escalate", reason: "Late escalation." },
		});

		await waitFor(() => inboxText(asker).includes("Late escalation."));
	});

	it("delivers a Supervisor answer to a nonblocking question through the inbox", async () => {
		const controlDbPath = sharedControlDb();
		const supervisor = await openSupervisor(controlDbPath);
		supervisor.setResponses([
			supervisorResponse({
				kind: "answer",
				answers: { [QUESTION]: { answer: "jest", reason: "The repo already uses jest" } },
			}),
		]);
		const askerUi = panelUi();
		const asker = await openSession(controlDbPath, askerUi, supervisor.sessionManager.getSessionId());
		asker.setResponses([askCall(false), fauxAssistantMessage("Continuing."), fauxAssistantMessage("Noted.")]);
		await asker.session.prompt("Pick a runner.");
		expect(askResult(asker).details).toMatchObject({ queued: true });
		await waitFor(() => inboxText(asker).includes("Supervisor answered questions (request"));

		expect(inboxText(asker)).toContain("jest (Supervisor: The repo already uses jest)");
		expect(askerUi.closed).toBe(1);
	});

	it("reopens a stored escalated question when the Supervisor session starts", async () => {
		const controlDbPath = sharedControlDb();
		// An escalation left open by a Supervisor process that stopped with its panel open.
		const route = { sessionId: "asker", agentId: null, requestId: "call-1" };
		const id = postSupervisorRequest(controlDbPath, {
			deadlineAt: "9999-12-31T23:59:59.999Z",
			kind: "question",
			payload: {
				blocking: true,
				questions: [{ question: QUESTION, options: [{ label: "vitest" }, { label: "jest" }] }],
			},
			projectId: "pi",
			replyTo: route,
			senderSessionId: "asker",
		});
		const claimed = claimNextSupervisorRequest(controlDbPath, "stopped-supervisor");
		completeSupervisorRequest(controlDbPath, id, claimed?.claimToken ?? "", {
			kind: "escalate",
			reason: "Tradeoff.",
		});

		const supervisorUi = panelUi();
		await openSupervisor(controlDbPath, supervisorUi);
		await waitFor(() => supervisorUi.panels.length === 1);
		supervisorUi.panels[0]?.handleInput?.(ENTER);
		await waitFor(() => readSupervisorRequest(controlDbPath, id)?.status === "completed");

		expect(readSupervisorRequest(controlDbPath, id)?.response).toMatchObject({
			answeredBy: "user",
			answers: { [QUESTION]: { answer: "vitest" } },
		});
		expect(listRuntimeMailboxMessages(controlDbPath).map((message) => message.storeRef.messageId)).toContain(
			"supervisor_response:asker:main:call-1:answer",
		);
	});

	it("closes the Supervisor panel when the CLI answers, then delivers a revision as a correction", async () => {
		const controlDbPath = sharedControlDb();
		const supervisorUi = panelUi();
		const supervisor = await openSupervisor(controlDbPath, supervisorUi);
		const supervisorSessionId = supervisor.sessionManager.getSessionId();
		supervisor.setResponses([supervisorResponse({ kind: "escalate", reason: "This is a product tradeoff." })]);
		const askerUi = panelUi();
		const asker = await openSession(controlDbPath, askerUi, supervisorSessionId);
		asker.setResponses([askCall(true), fauxAssistantMessage("Using vitest."), fauxAssistantMessage("Switching.")]);
		const turn = asker.session.prompt("Pick a runner.");
		await waitFor(() => supervisorUi.panels.length === 1);

		expect(answerQuestionAsUser(controlDbPath, supervisorSessionId, 1, { [QUESTION]: "vitest" })).toBeDefined();
		await turn;
		await waitFor(() => supervisorUi.closed === 1);
		expect(askResult(asker).details).toMatchObject({ answers: { [QUESTION]: "vitest" }, answeredBy: "user" });

		expect(reviseQuestionAsUser(controlDbPath, supervisorSessionId, 1, { [QUESTION]: "jest" })).toBeDefined();
		await waitFor(() => inboxText(asker).includes("User revised answers (request"));
		expect(inboxText(asker)).toContain(`- ${QUESTION} → jest`);
		expect(readSupervisorRequest(controlDbPath, 1)?.response).toMatchObject({
			answeredBy: "user",
			answers: { [QUESTION]: { answer: "jest" } },
		});
	}, 45_000);
});
