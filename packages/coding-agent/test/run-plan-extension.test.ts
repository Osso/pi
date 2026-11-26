import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import runPlanExtension, { findNextPlanItem } from "../extensions/run-plan/src/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";

type RegisteredRunPlanCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;

function createRunPlanHarness(
	cwd: string,
	options: { idle?: boolean; entries?: Array<Record<string, unknown>>; sessionManager?: SessionManager } = {},
) {
	let command: RegisteredRunPlanCommand | undefined;
	const eventHandlers = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void>();
	const entries = options.entries ?? [];
	const appendEntry = vi.fn((customType: string, data: unknown) => {
		entries.push({ type: "custom", customType, data });
	});
	const notify = vi.fn();
	const sendUserMessage = vi.fn();
	const setEditorText = vi.fn();
	const isIdle = vi.fn(() => options.idle ?? true);

	const pi = {
		appendEntry,
		on(event: string, handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void) {
			eventHandlers.set(event, handler);
		},
		registerCommand(name: string, options: RegisteredRunPlanCommand) {
			if (name === "run-plan") {
				command = options;
			}
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;

	runPlanExtension(pi);

	const ctx = {
		cwd,
		isIdle,
		sessionManager: options.sessionManager ?? {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionFile: () => undefined,
		},
		ui: { notify, setEditorText },
	} as unknown as ExtensionCommandContext;

	return {
		complete: async (prefix: string) => command?.getArgumentCompletions?.(prefix),
		runCommand: async (args: string) => command?.handler(args, ctx),
		runEvent: async (event: string, payload: Record<string, unknown> = {}) =>
			eventHandlers.get(event)?.({ type: event, ...payload }, ctx),
		appendEntry,
		entries,
		notify,
		sendUserMessage,
		setEditorText,
	};
}

describe("run-plan extension", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-run-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		delete process.env.PLAN_FILE;
		delete process.env.PLAN_PATH;
		delete process.env.PI_PLAN_FILE;
		delete process.env.PI_PLAN_PATH;
	});

	it("finds the first unchecked plan item and skips checked items", async () => {
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(
			planPath,
			["- [x] Done item", "* [X] Also done", "- [ ] First open item", "* [ ] Second open item"].join("\n"),
		);

		await expect(findNextPlanItem(planPath)).resolves.toBe("First open item");
	});

	it("skips unchecked items without text", async () => {
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(planPath, "- [ ] \n- [ ] Real item\n");

		await expect(findNextPlanItem(planPath)).resolves.toBe("Real item");
	});

	it("returns null when all plan items are checked", async () => {
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(planPath, "- [x] Done item\n* [X] Also done\n");

		await expect(findNextPlanItem(planPath)).resolves.toBeNull();
	});

	it("submits the next item and records the active plan file", async () => {
		writeFileSync(join(cwd, "PLAN.md"), "- [ ] Implement run plan\n");
		const harness = createRunPlanHarness(cwd);

		await harness.runCommand("");

		expect(process.env.PLAN_FILE).toBe("1");
		expect(process.env.PLAN_PATH).toBe(join(cwd, "PLAN.md"));
		expect(process.env.PI_PLAN_FILE).toBe("PLAN.md");
		expect(process.env.PI_PLAN_PATH).toBe(join(cwd, "PLAN.md"));
		expect(harness.appendEntry).toHaveBeenCalledWith("run-plan:active", {
			file: "PLAN.md",
			path: join(cwd, "PLAN.md"),
		});
		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			"Implement run plan\n\n[run-plan: Do not read PLAN.md. Work on this selected item, then check off that exact item in PLAN.md when it is resolved.]",
		);
	});

	it("clears the editor after dispatching the next item", async () => {
		writeFileSync(join(cwd, "PLAN.md"), "- [ ] Implement run plan\n");
		const harness = createRunPlanHarness(cwd);

		await harness.runCommand("");

		expect(harness.setEditorText).toHaveBeenCalledWith("");
	});

	it("prompts the agent again after completion while the active plan item remains unchecked", async () => {
		writeFileSync(join(cwd, "PLAN.md"), "- [ ] Keep working\n");
		const harness = createRunPlanHarness(cwd);

		await harness.runCommand("");
		await harness.runEvent("agent_settled");

		expect(harness.sendUserMessage).toHaveBeenCalledTimes(2);
		expect(harness.sendUserMessage).toHaveBeenLastCalledWith(
			"Keep working\n\n[run-plan: Do not read PLAN.md. Work on this selected item, then check off that exact item in PLAN.md when it is resolved.]",
			{ deliverAs: "followUp" },
		);
	});

	it("restores the active plan after cwd relocation rebuilds the extension", async () => {
		writeFileSync(join(cwd, "PLAN.md"), "- [ ] Keep working\n");
		const entries: Array<Record<string, unknown>> = [];
		const original = createRunPlanHarness(cwd, { entries });

		await original.runCommand("");

		const replacement = createRunPlanHarness(cwd, { entries });
		await replacement.runEvent("session_start");
		await replacement.runEvent("agent_settled");

		expect(replacement.sendUserMessage).toHaveBeenCalledWith(
			"Keep working\n\n[run-plan: Do not read PLAN.md. Work on this selected item, then check off that exact item in PLAN.md when it is resolved.]",
			{ deliverAs: "followUp" },
		);
	});

	it("restores the active plan saved before the loaded slice of a reopened compacted session", async () => {
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(planPath, "- [ ] Keep working\n");
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-run-plan-slice-"));
		try {
			const session = SessionManager.create(cwd, sessionDir);
			session.appendMessage({ role: "user", content: "start", timestamp: 1 });
			session.appendCustomEntry("run-plan:active", { file: "PLAN.md", path: planPath });
			const firstKeptId = session.appendMessage({ role: "user", content: "kept", timestamp: 2 });
			session.appendCompaction("summary", firstKeptId, 100);
			session.appendMessage({ role: "user", content: "after", timestamp: 3 });
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("expected persisted session file");

			const restored = createRunPlanHarness(cwd, { sessionManager: SessionManager.open(sessionFile, sessionDir) });
			await restored.runEvent("session_start");
			await restored.runEvent("agent_settled");

			expect(process.env.PLAN_PATH).toBe(planPath);
			expect(restored.sendUserMessage).toHaveBeenCalledWith(
				"Keep working\n\n[run-plan: Do not read PLAN.md. Work on this selected item, then check off that exact item in PLAN.md when it is resolved.]",
				{ deliverAs: "followUp" },
			);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("clears active plan environment when resumed history omits its state", async () => {
		const planPath = join(cwd, "PLAN.md");
		const original = createRunPlanHarness(cwd, {
			entries: [
				{
					type: "custom",
					customType: "run-plan:active",
					data: { file: "PLAN.md", path: planPath },
				},
			],
		});
		await original.runEvent("session_start");
		expect(process.env.PLAN_PATH).toBe(planPath);

		const replacement = createRunPlanHarness(cwd);
		await replacement.runEvent("session_start");

		expect([
			process.env.PLAN_FILE,
			process.env.PLAN_PATH,
			process.env.PI_PLAN_FILE,
			process.env.PI_PLAN_PATH,
		]).toEqual([undefined, undefined, undefined, undefined]);
	});

	it("persists cleared plan state after the last item is checked", async () => {
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(planPath, "- [ ] Finish work\n");
		const entries: Array<Record<string, unknown>> = [];
		const harness = createRunPlanHarness(cwd, { entries });

		await harness.runCommand("");
		writeFileSync(planPath, "- [x] Finish work\n");
		await harness.runEvent("agent_settled");

		expect(entries.at(-1)).toMatchObject({ type: "custom", customType: "run-plan:active", data: null });
	});

	it("does not restore a plan that /run-plan found complete", async () => {
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(planPath, "- [ ] Original task\n");
		const entries: Array<Record<string, unknown>> = [];
		const harness = createRunPlanHarness(cwd, { entries });
		await harness.runCommand("");
		writeFileSync(planPath, "- [x] Original task\n");
		await harness.runCommand("");
		expect(harness.notify).toHaveBeenCalledWith("No unchecked items in PLAN.md", "info");

		const reloaded = createRunPlanHarness(cwd, { entries });
		await reloaded.runEvent("session_start");
		writeFileSync(planPath, "- [x] Original task\n- [ ] Newly added task\n");
		await reloaded.runEvent("agent_settled");

		expect(reloaded.sendUserMessage).not.toHaveBeenCalled();
	});

	it("stops the active plan when its file is deleted before the run ends", async () => {
		const planPath = join(cwd, "PLAN.md");
		writeFileSync(planPath, "- [ ] Old task\n");
		const harness = createRunPlanHarness(cwd);
		await harness.runCommand("");
		rmSync(planPath);

		await harness.runEvent("agent_settled");
		expect(harness.entries.at(-1)).toEqual({ type: "custom", customType: "run-plan:active", data: null });
		expect(harness.notify).toHaveBeenCalledWith("Plan file not found: PLAN.md; stopped /run-plan", "warning");

		writeFileSync(planPath, "- [ ] Unrelated new plan\n");
		await harness.runEvent("agent_settled");
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("uses an inline plan filename argument", async () => {
		writeFileSync(join(cwd, "ALT.md"), "* [ ] Alternate plan\n");
		const harness = createRunPlanHarness(cwd);

		await harness.runCommand("ALT.md");

		expect(process.env.PLAN_FILE).toBe("ALT.md");
		expect(process.env.PLAN_PATH).toBe(join(cwd, "ALT.md"));
		expect(process.env.PI_PLAN_FILE).toBe("ALT.md");
		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			"Alternate plan\n\n[run-plan: Do not read ALT.md. Work on this selected item, then check off that exact item in ALT.md when it is resolved.]",
		);

		// The follow-up for the next item must also name the active plan file, not PLAN.md.
		writeFileSync(join(cwd, "ALT.md"), "* [x] Alternate plan\n* [ ] Second alternate\n");
		await harness.runEvent("agent_settled");
		expect(harness.sendUserMessage).toHaveBeenLastCalledWith(
			"Second alternate\n\n[run-plan: Do not read ALT.md. Work on this selected item, then check off that exact item in ALT.md when it is resolved.]",
			{ deliverAs: "followUp" },
		);
	});

	it("accepts an absolute plan path", async () => {
		const otherDir = join(cwd, "other");
		mkdirSync(otherDir);
		writeFileSync(join(otherDir, "TODO.md"), "- [ ] Elsewhere\n");
		const harness = createRunPlanHarness(join(cwd, "session"));

		await harness.runCommand(join(otherDir, "TODO.md"));

		expect(process.env.PLAN_PATH).toBe(join(otherDir, "TODO.md"));
		expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("throws when the plan file is missing", async () => {
		const harness = createRunPlanHarness(cwd);

		await expect(harness.runCommand("MISSING.md")).rejects.toThrow("Plan file not found: MISSING.md");
		expect(harness.notify).not.toHaveBeenCalled();
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("notifies when the plan file is complete", async () => {
		writeFileSync(join(cwd, "PLAN.md"), "- [x] Done\n");
		const harness = createRunPlanHarness(cwd);

		await harness.runCommand("");

		expect(harness.notify).toHaveBeenCalledWith("No unchecked items in PLAN.md", "info");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("blocks while a task is running", async () => {
		writeFileSync(join(cwd, "PLAN.md"), "- [ ] Implement run plan\n");
		const harness = createRunPlanHarness(cwd, { idle: false });

		await expect(harness.runCommand("")).rejects.toThrow("/run-plan is blocked while a task is running");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("completes markdown files in the session cwd", async () => {
		writeFileSync(join(cwd, "PLAN.md"), "- [ ] Default\n");
		writeFileSync(join(cwd, "ALT.md"), "- [ ] Alternate\n");
		writeFileSync(join(cwd, "notes.txt"), "- [ ] Ignored\n");
		const harness = createRunPlanHarness(cwd);
		await harness.runEvent("session_start");

		expect(process.cwd()).not.toBe(cwd);
		const completions = await harness.complete("");
		expect(completions?.map((completion) => completion.value).sort()).toEqual(["ALT.md", "PLAN.md"]);
	});
});
