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
import { getControlDbPath, readSupervisorRequest } from "../../src/core/session-control-db.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
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
		const inboxText = () =>
			asker.session.messages
				.flatMap((message) =>
					message.role === "user" && Array.isArray(message.content)
						? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
						: [],
				)
				.join("\n");
		await waitFor(() => inboxText().includes("Supervisor answered questions (request"));

		expect(inboxText()).toContain("jest (Supervisor: The repo already uses jest)");
		expect(askerUi.closed).toBe(1);
	});
});
