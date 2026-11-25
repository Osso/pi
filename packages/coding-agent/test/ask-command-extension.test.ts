import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskCommand } from "../extensions/supervisor-session/src/ask-command.ts";
import { ENV_AGENT_DIR, ENV_STATE_DIR } from "../src/config.ts";
import type { ExtensionCommandContext, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { getControlDbPath, listUserQuestions, postSupervisorRequest } from "../src/core/session-control-db.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

interface FakeUi {
	select: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
}

describe("/ask", () => {
	let root: string;
	let harness: Harness;
	const savedEnv = { agent: process.env[ENV_AGENT_DIR], state: process.env[ENV_STATE_DIR] };

	/** A laptop session that asked the user a question becomes an /ask target (no remote discovery). */
	function seedLaptopSession(sessionId: string): void {
		postSupervisorRequest(getControlDbPath(), {
			deadlineAt: "9999-12-31T23:59:59.999Z",
			kind: "question",
			payload: { blocking: true, questions: [{ question: `Question from ${sessionId}?` }] },
			projectId: "pi",
			replyTo: { sessionId, agentId: null, requestId: `call-${sessionId}`, host: "laptop" },
			senderSessionId: sessionId,
		});
	}

	async function runAsk(args: string, ui: Partial<FakeUi> = {}): Promise<FakeUi> {
		const runner = harness.session.extensionRunner;
		const command = runner?.getCommand("ask");
		if (!runner || !command) throw new Error("Expected the /ask command");
		const fake: FakeUi = { select: vi.fn(), input: vi.fn(), notify: vi.fn(), ...ui };
		const context: ExtensionCommandContext = runner.createCommandContext();
		Object.defineProperty(context, "ui", { value: fake as unknown as ExtensionUIContext });
		Object.defineProperty(context, "settingsManager", {
			value: SettingsManager.create(root, join(root, "agent"), { projectTrusted: false }),
		});
		await command.handler(args, context);
		return fake;
	}

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "pi-ask-command-"));
		mkdirSync(join(root, "agent"));
		process.env[ENV_AGENT_DIR] = join(root, "agent");
		process.env[ENV_STATE_DIR] = join(root, "state");
		writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ supervisor: { sessionId: "sup" } }));
		harness = await createHarnessWithExtensions({ extensionFactories: [registerAskCommand] });
	});

	afterEach(() => {
		harness.cleanup();
		rmSync(root, { recursive: true, force: true });
		for (const [key, value] of [
			[ENV_AGENT_DIR, savedEnv.agent],
			[ENV_STATE_DIR, savedEnv.state],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("stores a question for the session whose ID starts with the given prefix", async () => {
		seedLaptopSession("worker-7f3a");
		seedLaptopSession("reviewer-01");

		const ui = await runAsk("worker  Why did the   build fail?");

		expect(ui.notify).toHaveBeenCalledWith("Asked u1. The answer shows in pi questions.", "info");
		expect(listUserQuestions(getControlDbPath())).toEqual([
			expect.objectContaining({
				id: 1,
				targetSessionId: "worker-7f3a",
				targetHost: "laptop",
				question: "Why did the   build fail?",
				status: "open",
			}),
		]);
	});

	it("picks the session and reads the question when /ask has no arguments", async () => {
		seedLaptopSession("worker-7f3a");
		const ui = await runAsk("", {
			select: vi.fn().mockResolvedValue("laptop:worker-7f3a"),
			input: vi.fn().mockResolvedValue("Which package failed?"),
		});

		expect(ui.select).toHaveBeenCalledWith("Ask which session?", ["laptop:worker-7f3a"]);
		expect(listUserQuestions(getControlDbPath())).toEqual([
			expect.objectContaining({ targetSessionId: "worker-7f3a", question: "Which package failed?" }),
		]);
	});

	it("reports an ambiguous prefix and a missing question without storing anything", async () => {
		seedLaptopSession("worker-1");
		seedLaptopSession("worker-2");

		const ambiguous = await runAsk("worker hello?");
		const noQuestion = await runAsk("worker-1");

		expect(ambiguous.notify).toHaveBeenCalledWith("worker matches 2 sessions; type more of the session ID.", "error");
		expect(noQuestion.notify).toHaveBeenCalledWith("Usage: /ask [<session-id-prefix> <question>]", "error");
		expect(listUserQuestions(getControlDbPath())).toEqual([]);
	});

	it("reports that the store is on the Supervisor host when the session runs elsewhere", async () => {
		writeFileSync(
			join(root, "agent", "settings.json"),
			JSON.stringify({ supervisor: { sessionId: "sup", host: "agent-server-elsewhere" } }),
		);
		const ui = await runAsk("worker hello?");
		expect(ui.notify).toHaveBeenCalledWith(
			"The question store is on agent-server-elsewhere; run pi questions there.",
			"error",
		);
	});
});
