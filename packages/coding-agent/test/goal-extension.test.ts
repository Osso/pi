import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../../.pi/extensions/goal.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
} from "../src/core/extensions/types.ts";

type RegisteredGoalCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;

function createGoalHarness(cwd: string) {
	let command: RegisteredGoalCommand | undefined;
	let beforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> | undefined;
	const notify = vi.fn();
	const sendUserMessage = vi.fn();

	const pi = {
		on(event: string, handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>) {
			if (event === "before_agent_start") {
				beforeAgentStart = handler;
			}
		},
		registerCommand(name: string, options: RegisteredGoalCommand) {
			if (name === "goal") {
				command = options;
			}
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;

	goalExtension(pi);

	const ctx = {
		cwd,
		ui: { notify },
		isIdle: () => true,
	} as unknown as ExtensionCommandContext;

	const event = {
		type: "before_agent_start",
		prompt: "prompt",
		images: undefined,
		systemPrompt: "base prompt",
		systemPromptOptions: { cwd, contextFiles: [], skills: [] },
	} satisfies BeforeAgentStartEvent;

	return {
		runCommand: async (args: string) => {
			await command?.handler(args, ctx);
		},
		runBeforeAgentStart: async () => beforeAgentStart?.(event, ctx as ExtensionContext),
		notify,
		sendUserMessage,
	};
}

describe("goal extension", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = join(tmpdir(), `pi-goal-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("sets an objective, persists it, and starts work when idle", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("ship the goal feature");

		const goal = JSON.parse(readFileSync(join(cwd, ".pi", "goal.json"), "utf8")) as { objective: string };
		expect(goal.objective).toBe("ship the goal feature");
		expect(harness.notify).toHaveBeenCalledWith("Goal set — starting work", "info");
		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			"Work toward this objective until it is achieved: ship the goal feature",
		);
	});

	it("injects the active objective into the system prompt", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("keep context anchored");

		const result = await harness.runBeforeAgentStart();
		expect(result?.systemPrompt).toContain("<goal>");
		expect(result?.systemPrompt).toContain("Long-running objective: keep context anchored");
		expect(result?.systemPrompt).toContain("base prompt");
	});

	it("shows and clears the active objective", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("clearable objective");
		await harness.runCommand("");
		await harness.runCommand("clear");
		await harness.runCommand("");

		expect(harness.notify).toHaveBeenCalledWith("Goal: clearable objective", "info");
		expect(harness.notify).toHaveBeenCalledWith("Goal cleared", "info");
		expect(harness.notify).toHaveBeenCalledWith("No active goal — use /goal <objective>", "info");
	});

	it("rejects objectives longer than the codex limit", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("x".repeat(4001));

		expect(harness.notify).toHaveBeenCalledWith("Objective too long (4001 > 4000 chars)", "error");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});
});
