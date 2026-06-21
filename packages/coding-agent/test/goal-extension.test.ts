import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../../.pi/extensions/goal.ts";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
	SessionStartEvent,
	ToolDefinition,
} from "../src/core/extensions/types.ts";

type RegisteredGoalCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;
type GoalCompleteTool = ToolDefinition;
type GoalEvent = AgentEndEvent | BeforeAgentStartEvent | SessionStartEvent;
type GoalEventResult = BeforeAgentStartEventResult | undefined;

function createGoalHarness(cwd: string, options?: { idle?: boolean }) {
	let command: RegisteredGoalCommand | undefined;
	let completeTool: GoalCompleteTool | undefined;
	let agentEnd: ExtensionHandler<AgentEndEvent, undefined> | undefined;
	let beforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> | undefined;
	let sessionStart: ExtensionHandler<SessionStartEvent, undefined> | undefined;
	const notify = vi.fn();
	const sendUserMessage = vi.fn();

	const pi = {
		on(event: string, handler: ExtensionHandler<GoalEvent, GoalEventResult>) {
			if (event === "agent_end") {
				agentEnd = handler as ExtensionHandler<AgentEndEvent, undefined>;
			}
			if (event === "before_agent_start") {
				beforeAgentStart = handler as ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
			}
			if (event === "session_start") {
				sessionStart = handler as ExtensionHandler<SessionStartEvent, undefined>;
			}
		},
		registerCommand(name: string, options: RegisteredGoalCommand) {
			if (name === "goal") {
				command = options;
			}
		},
		registerTool(tool: GoalCompleteTool) {
			if (tool.name === "goal_complete") {
				completeTool = tool;
			}
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;

	goalExtension(pi);

	const ctx = {
		cwd,
		ui: { notify },
		isIdle: () => options?.idle ?? true,
		hasPendingMessages: () => false,
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
		runSessionStart: async (reason: SessionStartEvent["reason"]) =>
			sessionStart?.({ type: "session_start", reason }, ctx as ExtensionContext),
		runAgentEnd: async () => agentEnd?.({ type: "agent_end", messages: [] }, ctx as ExtensionContext),
		runGoalComplete: async (reason: string) =>
			completeTool?.execute("goal-complete-1", { reason }, undefined, undefined, ctx as ExtensionContext),
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

	it("notifies when a persisted goal is restored on resume, reload, and fork", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("resume this objective");
		harness.notify.mockClear();
		await harness.runSessionStart("resume");
		await harness.runSessionStart("reload");
		await harness.runSessionStart("fork");

		expect(harness.notify).toHaveBeenCalledTimes(3);
		expect(harness.notify).toHaveBeenNthCalledWith(1, "Active goal: resume this objective", "info");
		expect(harness.notify).toHaveBeenNthCalledWith(2, "Active goal: resume this objective", "info");
		expect(harness.notify).toHaveBeenNthCalledWith(3, "Active goal: resume this objective", "info");
	});

	it("treats corrupt goal state as no active objective", async () => {
		const harness = createGoalHarness(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "goal.json"), "{not json", "utf8");

		await harness.runCommand("");
		const result = await harness.runBeforeAgentStart();

		expect(harness.notify).toHaveBeenCalledWith("No active goal — use /goal <objective>", "info");
		expect(result).toBeUndefined();
	});

	it("continues an active goal after agent_end", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("continue this objective");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd();

		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			"Continue working toward this objective until it is achieved: continue this objective",
		);
	});

	it("does not continue when the agent is busy", async () => {
		const harness = createGoalHarness(cwd, { idle: false });

		await harness.runCommand("do not overlap");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd();

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("stops continuation after goal_complete is called", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("complete explicitly");
		const result = await harness.runGoalComplete("done");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd();

		expect(result?.content).toEqual([{ type: "text", text: "Goal marked complete: done" }]);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("stops continuation at the turn cap", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("bounded continuation");
		harness.sendUserMessage.mockClear();
		for (let i = 0; i < 9; i++) {
			await harness.runAgentEnd();
		}

		expect(harness.sendUserMessage).toHaveBeenCalledTimes(8);
		expect(harness.notify).toHaveBeenCalledWith("Goal continuation stopped at turn cap (8)", "warning");
	});
});
