import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Component, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	listRuntimeMailboxMessages as listAllRuntimeMailboxMessages,
	type RuntimeMailboxAddress,
} from "../src/core/session-control-db.ts";
import { type AskQuestionsToolInput, createAskQuestionsToolDefinition } from "../src/core/tools/ask-questions.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";

vi.mock("../src/core/desktop-notification.ts", () => ({
	PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS: 2147483647,
	sendDesktopNotification: () => ({ close: () => {} }),
}));

function listRuntimeMailboxMessages(controlDbPath: string, recipient: RuntimeMailboxAddress) {
	return listAllRuntimeMailboxMessages(controlDbPath).filter(
		(message) =>
			message.recipient.sessionId === recipient.sessionId && message.recipient.agentId === recipient.agentId,
	);
}

const roots: string[] = [];
const questions = [{ question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] }];

function fixture(agentId?: string) {
	const root = mkdtempSync(join(tmpdir(), "pi-ask-async-"));
	roots.push(root);
	const controlDbPath = join(root, "control.sqlite");
	let sessionId = "asker-session";
	let sessionPath = join(root, "asker.jsonl");
	const recipient = { sessionId, agentId: agentId ?? null };
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const panels: Component[] = [];
	const errors: string[] = [];
	const ui = {
		custom: <T>(
			factory: (
				tui: TUI,
				theme: Theme,
				kb: KeybindingsManager,
				done: (result: T) => void,
			) => Component | Promise<Component>,
		) =>
			new Promise<T>((resolve, reject) => {
				Promise.resolve(factory({ requestRender: () => {} } as TUI, theme, keybindings, resolve)).then(
					(panel) => panels.push(panel),
					reject,
				);
			}),
		notify: (message: string) => errors.push(message),
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui,
		controlDbPath,
		multiAgentAgentId: agentId,
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionPath },
	} as unknown as ExtensionContext;
	return {
		ctx,
		panels,
		errors,
		controlDbPath,
		recipient,
		switchSession: () => {
			sessionId = "other-session";
			sessionPath = join(root, "other.jsonl");
			ctx.multiAgentAgentId = "other-agent";
		},
	};
}

beforeAll(() => initTheme("dark"));
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("asynchronous ask_questions", () => {
	it("requires explicit blocking in schema and execution", async () => {
		const tool = createAskQuestionsToolDefinition();
		const params = { questions };
		expect(Value.Check(tool.parameters, params)).toBe(false);
		await expect(
			tool.execute("missing-mode", params as AskQuestionsToolInput, undefined, undefined, fixture().ctx),
		).rejects.toThrow(/blocking/);
	});

	it("accepts free-text questions without fabricated choices", () => {
		const tool = createAskQuestionsToolDefinition();
		expect(
			Value.Check(tool.parameters, { blocking: true, questions: [{ question: "What is the project name?" }] }),
		).toBe(true);
	});

	it("returns before answers, then delivers the answer to the original session inbox", async () => {
		const f = fixture();
		const tool = createAskQuestionsToolDefinition();
		const result = await tool.execute("async-one", { blocking: false, questions }, undefined, undefined, f.ctx);
		expect(result.details).toMatchObject({ queued: true, requestId: "async-one", cancelled: false, answers: {} });
		await vi.waitFor(() => expect(f.panels).toHaveLength(1));
		expect(listRuntimeMailboxMessages(f.controlDbPath, f.recipient)).toEqual([]);
		f.switchSession();
		f.panels[0].handleInput?.("\r");
		await vi.waitFor(() => expect(listRuntimeMailboxMessages(f.controlDbPath, f.recipient)).toHaveLength(1));
		const [message] = listRuntimeMailboxMessages(f.controlDbPath, f.recipient);
		expect(message.body).toContain("User answered questions (request async-one):");
		expect(message.body).toContain("Which database? → SQLite");
		expect(message.storeRef.messageId).toContain("async-one");
		expect(
			listRuntimeMailboxMessages(f.controlDbPath, { sessionId: "other-session", agentId: "other-agent" }),
		).toEqual([]);
		expect(f.errors).toEqual([]);
	});

	it("queues two requests without replacing the first panel and routes child cancellation", async () => {
		const f = fixture("child-1");
		const tool = createAskQuestionsToolDefinition();
		await tool.execute("first", { blocking: false, questions }, undefined, undefined, f.ctx);
		await tool.execute("second", { blocking: false, questions }, undefined, undefined, f.ctx);
		await vi.waitFor(() => expect(f.panels).toHaveLength(1));
		f.panels[0].handleInput?.("\r");
		await vi.waitFor(() => expect(f.panels).toHaveLength(2));
		f.panels[1].handleInput?.("\x1b");
		await vi.waitFor(() => expect(listRuntimeMailboxMessages(f.controlDbPath, f.recipient)).toHaveLength(2));
		const messages = listRuntimeMailboxMessages(f.controlDbPath, f.recipient);
		expect(messages.map((message) => message.recipient.agentId)).toEqual(["child-1", "child-1"]);
		expect(messages[0].body).toContain("request first");
		expect(messages[1].body).toContain("Questions cancelled (request second)");
		expect(listRuntimeMailboxMessages(f.controlDbPath, { sessionId: f.recipient.sessionId, agentId: null })).toEqual(
			[],
		);
	});

	it("keeps blocking calls pending until the user answers and sends no duplicate inbox message", async () => {
		const f = fixture();
		let returned = false;
		const pending = createAskQuestionsToolDefinition()
			.execute("blocking-one", { blocking: true, questions }, undefined, undefined, f.ctx)
			.then((result) => {
				returned = true;
				return result;
			});
		await vi.waitFor(() => expect(f.panels).toHaveLength(1));
		expect(returned).toBe(false);
		f.panels[0].handleInput?.("\r");
		expect((await pending).details?.answers).toEqual({ "Which database?": "SQLite" });
		expect(listRuntimeMailboxMessages(f.controlDbPath, f.recipient)).toEqual([]);
	});

	it("keeps a blocking request behind an unanswered nonblocking panel", async () => {
		const f = fixture();
		const tool = createAskQuestionsToolDefinition();
		await tool.execute("queued-first", { blocking: false, questions }, undefined, undefined, f.ctx);
		let returned = false;
		const blocking = tool
			.execute("blocking-second", { blocking: true, questions }, undefined, undefined, f.ctx)
			.then((result) => {
				returned = true;
				return result;
			});
		await vi.waitFor(() => expect(f.panels).toHaveLength(1));
		expect(returned).toBe(false);
		f.panels[0].handleInput?.("\r");
		await vi.waitFor(() => expect(f.panels).toHaveLength(2));
		expect(returned).toBe(false);
		f.panels[1].handleInput?.("\r");
		expect((await blocking).details?.answers).toEqual({ "Which database?": "SQLite" });
		expect(listRuntimeMailboxMessages(f.controlDbPath, f.recipient)).toHaveLength(1);
	});

	it("delivers panel failure and continues the next queued request", async () => {
		const f = fixture();
		vi.spyOn(f.ctx.ui, "custom").mockRejectedValueOnce(new Error("Panel cannot open"));
		const tool = createAskQuestionsToolDefinition();
		await tool.execute("failed-panel", { blocking: false, questions }, undefined, undefined, f.ctx);
		await tool.execute("next-panel", { blocking: false, questions }, undefined, undefined, f.ctx);
		await vi.waitFor(() => expect(f.panels).toHaveLength(1));
		expect(f.errors).toEqual(["Questions failed (request failed-panel): Panel cannot open"]);
		expect(listRuntimeMailboxMessages(f.controlDbPath, f.recipient)[0].body).toContain(
			"Questions failed (request failed-panel)",
		);
		f.panels[0].handleInput?.("\r");
		await vi.waitFor(() => expect(listRuntimeMailboxMessages(f.controlDbPath, f.recipient)).toHaveLength(2));
		expect(listRuntimeMailboxMessages(f.controlDbPath, f.recipient)[1].body).toContain(
			"User answered questions (request next-panel)",
		);
	});

	it("reports a mailbox write failure instead of silently losing the submitted answer", async () => {
		const f = fixture();
		f.ctx.controlDbPath = dirname(f.controlDbPath);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await createAskQuestionsToolDefinition().execute(
				"write-failed",
				{ blocking: false, questions },
				undefined,
				undefined,
				f.ctx,
			);
			await vi.waitFor(() => expect(f.panels).toHaveLength(1));
			f.panels[0].handleInput?.("\r");
			await vi.waitFor(() => expect(f.errors).toHaveLength(1));
			expect(f.errors[0]).toContain("Failed to deliver question answer (request write-failed)");
			expect(logged).toHaveBeenCalledWith(f.errors[0]);
			expect(listRuntimeMailboxMessages(f.controlDbPath, f.recipient)).toEqual([]);
		} finally {
			logged.mockRestore();
		}
	});

	it("rejects free-text multiselect rather than displaying meaningless choices", async () => {
		const f = fixture();
		await expect(
			createAskQuestionsToolDefinition().execute(
				"invalid-free-text",
				{ blocking: true, questions: [{ question: "Explain?", multiSelect: true }] },
				undefined,
				undefined,
				f.ctx,
			),
		).rejects.toThrow(/cannot use multiSelect/);
		expect(f.panels).toEqual([]);
	});

	it("rejects nonblocking delivery without a persisted session before opening a panel", async () => {
		const f = fixture();
		f.ctx.sessionManager = {
			getSessionId: () => "ephemeral",
			getSessionFile: () => undefined,
		} as ExtensionContext["sessionManager"];
		await expect(
			createAskQuestionsToolDefinition().execute(
				"ephemeral",
				{ blocking: false, questions },
				undefined,
				undefined,
				f.ctx,
			),
		).rejects.toThrow(/persisted session/);
		expect(f.panels).toEqual([]);
	});
});
