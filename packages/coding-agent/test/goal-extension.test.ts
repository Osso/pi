import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, getModel, type Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../extensions/goal/src/index.ts";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ContextUsage,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
	SessionStartEvent,
	ToolDefinition,
} from "../src/core/extensions/types.ts";

type RegisteredGoalCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;
type GoalTool = ToolDefinition;
type GoalEvent = AgentEndEvent | BeforeAgentStartEvent | SessionStartEvent;
type GoalEventResult = BeforeAgentStartEventResult | undefined;

const model = getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Test model not found");

function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

function createGoalHarness(cwd: string, options?: { idle?: boolean; contextUsage?: ContextUsage }) {
	let command: RegisteredGoalCommand | undefined;
	let completeTool: GoalTool | undefined;
	let setGoalTool: GoalTool | undefined;
	let agentEnd: ExtensionHandler<AgentEndEvent, undefined> | undefined;
	let beforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult> | undefined;
	let sessionStart: ExtensionHandler<SessionStartEvent, undefined> | undefined;
	const notify = vi.fn();
	const sendUserMessage = vi.fn();
	const setStatus = vi.fn();

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
		registerTool(tool: GoalTool) {
			if (tool.name === "goal_complete") {
				completeTool = tool;
			}
			if (tool.name === "set_goal") {
				setGoalTool = tool;
			}
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;

	goalExtension(pi);

	const ctx = {
		cwd,
		ui: { notify, setStatus },
		isIdle: () => options?.idle ?? true,
		hasPendingMessages: () => false,
		getContextUsage: () => options?.contextUsage,
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
		runAgentEnd: async (messages: AgentEndEvent["messages"] = [createAssistantMessage("still working")]) =>
			agentEnd?.({ type: "agent_end", messages }, ctx as ExtensionContext),
		runGoalComplete: async (reason: string) =>
			completeTool?.execute("goal-complete-1", { reason }, undefined, undefined, ctx as ExtensionContext),
		runSetGoal: async (objective: string, replace = false) =>
			setGoalTool?.execute("set-goal-1", { objective, replace }, undefined, undefined, ctx as ExtensionContext),
		hasGoalCommand: () => command !== undefined,
		hasGoalCompleteTool: () => completeTool !== undefined,
		hasSetGoalTool: () => setGoalTool !== undefined,
		notify,
		setStatus,
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

	it("registers from the first-party extension path", () => {
		const harness = createGoalHarness(cwd);

		expect(harness.hasGoalCommand()).toBe(true);
		expect(harness.hasGoalCompleteTool()).toBe(true);
		expect(harness.hasSetGoalTool()).toBe(true);
	});

	it("sets an objective through the set_goal tool", async () => {
		const harness = createGoalHarness(cwd);

		const result = await harness.runSetGoal("ship tool parity");

		const goal = JSON.parse(readFileSync(join(cwd, ".pi", "goal.json"), "utf8")) as { objective: string };
		expect(goal.objective).toBe("ship tool parity");
		expect(result?.content).toEqual([{ type: "text", text: "Goal set: ship tool parity" }]);
		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			"Work toward this objective until it is achieved: ship tool parity",
		);
	});

	it("does not let the set_goal tool replace an active goal", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("first objective");
		harness.notify.mockClear();
		harness.sendUserMessage.mockClear();
		const result = await harness.runSetGoal("agent-chosen objective", true);

		const goal = JSON.parse(readFileSync(join(cwd, ".pi", "goal.json"), "utf8")) as { objective: string };
		expect(goal.objective).toBe("first objective");
		expect(result?.content).toEqual([
			{ type: "text", text: "Active goal already set — use /goal --replace <objective> to replace it" },
		]);
		expect(harness.notify).toHaveBeenCalledWith(
			"Active goal already set — use /goal --replace <objective> to replace it",
			"warning",
		);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
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

	it("requires an explicit replace flag before overwriting an active goal", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("first objective");
		harness.notify.mockClear();
		harness.sendUserMessage.mockClear();
		await harness.runCommand("second objective");

		const goal = JSON.parse(readFileSync(join(cwd, ".pi", "goal.json"), "utf8")) as { objective: string };
		expect(goal.objective).toBe("first objective");
		expect(harness.notify).toHaveBeenCalledWith(
			"Active goal already set — use /goal --replace <objective> to replace it",
			"warning",
		);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("replaces an active goal when the replace flag is present", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("first objective");
		harness.notify.mockClear();
		harness.sendUserMessage.mockClear();
		await harness.runCommand("--replace second objective");

		const goal = JSON.parse(readFileSync(join(cwd, ".pi", "goal.json"), "utf8")) as {
			objective: string;
			continuationTurns: number;
		};
		expect(goal.objective).toBe("second objective");
		expect(goal.continuationTurns).toBe(0);
		expect(harness.notify).toHaveBeenCalledWith("Goal replaced — starting work", "info");
		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			"Work toward this objective until it is achieved: second objective",
		);
	});

	it("injects the active objective into the system prompt", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("keep context anchored");

		const result = await harness.runBeforeAgentStart();
		expect(result?.systemPrompt).toContain("<goal>");
		expect(result?.systemPrompt).toContain("Long-running objective: keep context anchored");
		expect(result?.systemPrompt).toContain("When it is achieved, call the goal_complete tool.");
		expect(result?.systemPrompt).toContain("base prompt");
	});

	it("injects continuation and budget state into the system prompt", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("--token-budget 100 --wall-clock-minutes 5 budgeted context");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd();

		const result = await harness.runBeforeAgentStart();
		expect(result?.systemPrompt).toContain("Continuation turns used: 1");
		expect(result?.systemPrompt).toContain("Token budget: 100 tokens");
		expect(result?.systemPrompt).toContain("Wall-clock budget: 5m");
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

	it("treats goal state without an objective as no active objective", async () => {
		const harness = createGoalHarness(cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "goal.json"),
			`${JSON.stringify({ description: "legacy goal", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
			"utf8",
		);

		await harness.runSessionStart("startup");
		await harness.runCommand("");
		const result = await harness.runBeforeAgentStart();

		expect(harness.notify).toHaveBeenCalledWith("No active goal — use /goal <objective>", "info");
		expect(harness.notify).not.toHaveBeenCalledWith("Active goal: undefined", "info");
		expect(result).toBeUndefined();
	});

	it("treats completed goal state as no active objective", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("finish once");
		await harness.runGoalComplete("done");
		harness.notify.mockClear();
		const result = await harness.runBeforeAgentStart();
		await harness.runCommand("");

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
			{ deliverAs: "followUp" },
		);
	});

	it("continues after agent_end even before the runtime reports idle", async () => {
		const harness = createGoalHarness(cwd, { idle: false });

		await harness.runCommand("continue from agent_end");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd();

		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			"Continue working toward this objective until it is achieved: continue from agent_end",
			{ deliverAs: "followUp" },
		);
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

	it("continues without a numeric turn cap", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("long running continuation");
		harness.sendUserMessage.mockClear();
		for (let i = 0; i < 100; i++) {
			await harness.runAgentEnd();
		}

		expect(harness.sendUserMessage).toHaveBeenCalledTimes(100);
		expect(harness.notify).not.toHaveBeenCalledWith(expect.stringContaining("turn cap"), "warning");
	});

	it("stops continuation when the last assistant response is empty", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("empty response bounded");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd([createAssistantMessage("   ")]);

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			"Goal continuation stopped because the last assistant response was empty",
			"warning",
		);
	});

	it("persists a one-billion token budget by default", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("default budget objective");

		const goal = JSON.parse(readFileSync(join(cwd, ".pi", "goal.json"), "utf8")) as {
			objective: string;
			tokenBudget: number;
		};
		expect(goal.objective).toBe("default budget objective");
		expect(goal.tokenBudget).toBe(1_000_000_000);
	});

	it("persists explicit token and wall-clock budgets when setting a goal", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("--token-budget 100 --wall-clock-minutes 5 budgeted objective");

		const goal = JSON.parse(readFileSync(join(cwd, ".pi", "goal.json"), "utf8")) as {
			objective: string;
			tokenBudget: number;
			wallClockBudgetMs: number;
		};
		expect(goal.objective).toBe("budgeted objective");
		expect(goal.tokenBudget).toBe(100);
		expect(goal.wallClockBudgetMs).toBe(5 * 60 * 1000);
	});

	it("shows the active goal in the footer status", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("visible footer objective");
		await harness.runCommand("clear");

		expect(harness.setStatus).toHaveBeenCalledWith("goal", "goal: visible footer objective");
		expect(harness.setStatus).toHaveBeenCalledWith("goal", undefined);
	});

	it("stops continuation when the token budget is reached", async () => {
		const harness = createGoalHarness(cwd, { contextUsage: { tokens: 101, contextWindow: 1000, percent: 10.1 } });

		await harness.runCommand("--token-budget 100 token bounded");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd();

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("Goal continuation stopped at token budget (100)", "warning");
	});

	it("stops continuation when the wall-clock budget is reached", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("--wall-clock-minutes 1 time bounded");
		const goalPath = join(cwd, ".pi", "goal.json");
		const goal = JSON.parse(readFileSync(goalPath, "utf8")) as Record<string, unknown>;
		writeFileSync(goalPath, `${JSON.stringify({ ...goal, createdAt: "2000-01-01T00:00:00.000Z" })}\n`, "utf8");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd();

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("Goal continuation stopped at wall-clock budget (1m)", "warning");
	});
});
