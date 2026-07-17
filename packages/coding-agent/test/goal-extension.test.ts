import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, getModel, type Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import goalExtension, { type GoalSupervisorReview } from "../extensions/goal/src/index.ts";
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
import {
	claimNextSupervisorRequest,
	completeSupervisorRequest,
	getControlDbPath,
	readSupervisorRequest,
} from "../src/core/session-control-db.ts";

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

const storedGoalJsonBySession = new Map<string, string>();

function storedGoalKey(cwd: string, sessionId = "test-session"): string {
	return `${cwd}\0${sessionId}`;
}

function readStoredGoal<T>(cwd: string, sessionId = "test-session"): T {
	const goalJson = storedGoalJsonBySession.get(storedGoalKey(cwd, sessionId));
	if (!goalJson) throw new Error(`No stored goal for ${sessionId}`);
	return JSON.parse(goalJson) as T;
}

function writeStoredGoal(cwd: string, sessionId: string, goal: unknown): void {
	storedGoalJsonBySession.set(storedGoalKey(cwd, sessionId), `${JSON.stringify(goal)}\n`);
}

function sessionIdFromFile(file: string): string | undefined {
	try {
		const [firstLine] = readFileSync(file, "utf8").split("\n", 1);
		const parsed = JSON.parse(firstLine ?? "") as { id?: unknown };
		return typeof parsed.id === "string" ? parsed.id : undefined;
	} catch {
		return undefined;
	}
}

function createAssistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(),
		stopReason,
		timestamp: 1,
	};
}

function schemaHasProperty(schema: unknown, property: string): boolean {
	if (typeof schema !== "object" || schema === null || !("properties" in schema)) return false;
	const properties = schema.properties;
	return typeof properties === "object" && properties !== null && property in properties;
}

function createGoalHarness(
	cwd: string,
	options?: {
		idle?: boolean;
		contextUsage?: ContextUsage;
		hasPendingMessages?: boolean | (() => boolean);
		sessionId?: string;
		isSubagent?: boolean;
		subagentName?: string;
		reviewGoal?: GoalSupervisorReview;
		useResidentSupervisor?: boolean;
	},
) {
	let command: RegisteredGoalCommand | undefined;
	let manageGoalTool: GoalTool | undefined;
	const registeredToolNames: string[] = [];
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
			registeredToolNames.push(tool.name);
			if (tool.name === "manage_goal") {
				manageGoalTool = tool;
			}
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;

	const reviewGoal =
		options?.reviewGoal ??
		(async ({ kind, payload }) =>
			kind === "goal_completion_review"
				? { kind: "complete" as const, reason: "verified" }
				: {
						kind: "continue" as const,
						reason: "work remains",
						instructions: `Continue working toward this objective until it is achieved: ${String(payload.objective)}`,
					});
	goalExtension(pi, options?.useResidentSupervisor ? {} : { reviewGoal });

	const ctx = {
		cwd,
		ui: { notify, setStatus },
		sessionManager: {
			getSessionId: () => options?.sessionId ?? "test-session",
			getSessionGoalJson: () =>
				storedGoalJsonBySession.get(storedGoalKey(cwd, options?.sessionId ?? "test-session")),
			getSessionGoalJsonForSession: (sessionFile: string) => {
				const sessionId = sessionIdFromFile(sessionFile);
				return sessionId ? storedGoalJsonBySession.get(storedGoalKey(cwd, sessionId)) : undefined;
			},
			setSessionGoalJson: (goalJson: string) => {
				storedGoalJsonBySession.set(storedGoalKey(cwd, options?.sessionId ?? "test-session"), goalJson);
			},
			clearSessionGoalJson: () => {
				storedGoalJsonBySession.delete(storedGoalKey(cwd, options?.sessionId ?? "test-session"));
			},
			isSubagentSession: () => options?.isSubagent ?? false,
			getSubagentName: () => options?.subagentName,
		},
		isIdle: () => options?.idle ?? true,
		hasPendingMessages: () =>
			typeof options?.hasPendingMessages === "function"
				? options.hasPendingMessages()
				: (options?.hasPendingMessages ?? false),
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
		runSessionStart: async (reason: SessionStartEvent["reason"], previousSessionFile?: string) =>
			sessionStart?.({ type: "session_start", reason, previousSessionFile }, ctx as ExtensionContext),
		runAgentEnd: async (messages: AgentEndEvent["messages"] = [createAssistantMessage("still working")]) =>
			agentEnd?.({ type: "agent_end", messages }, ctx as ExtensionContext),
		runGoalComplete: async (reason: string) =>
			manageGoalTool?.execute(
				"manage-goal-complete-1",
				{ action: "complete", reason },
				undefined,
				undefined,
				ctx as ExtensionContext,
			),
		runPauseGoal: async () =>
			manageGoalTool?.execute(
				"manage-goal-pause-1",
				{ action: "pause" },
				undefined,
				undefined,
				ctx as ExtensionContext,
			),
		runSetGoal: async (objective: string) =>
			manageGoalTool?.execute(
				"manage-goal-set-1",
				{ action: "set", objective },
				undefined,
				undefined,
				ctx as ExtensionContext,
			),
		getManageGoalTool: () => manageGoalTool,
		getRegisteredToolNames: () => registeredToolNames,
		hasGoalCommand: () => command !== undefined,
		hasManageGoalTool: () => manageGoalTool !== undefined,
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
		for (const key of storedGoalJsonBySession.keys()) {
			if (key.startsWith(`${cwd}\0`)) storedGoalJsonBySession.delete(key);
		}
		rmSync(cwd, { recursive: true, force: true });
	});

	it("registers only the manage_goal lifecycle tool from the first-party extension path", () => {
		const harness = createGoalHarness(cwd);

		expect(harness.hasGoalCommand()).toBe(true);
		expect(harness.hasManageGoalTool()).toBe(true);
		expect(harness.getRegisteredToolNames()).toContain("manage_goal");
		expect(harness.getRegisteredToolNames()).not.toContain("set_goal");
		expect(harness.getRegisteredToolNames()).not.toContain("pause_goal");
		expect(harness.getRegisteredToolNames()).not.toContain("goal_complete");
	});

	it("exposes manage_goal without budget parameters or guidance", () => {
		const harness = createGoalHarness(cwd);
		const manageGoalTool = harness.getManageGoalTool();

		expect(manageGoalTool?.description).not.toContain("budget");
		expect(manageGoalTool?.description).not.toContain("tokenBudget");
		expect(manageGoalTool?.description).not.toContain("wallClockMinutes");
		expect(manageGoalTool?.promptGuidelines).toEqual([]);
		expect(schemaHasProperty(manageGoalTool?.parameters, "action")).toBe(true);
		expect(schemaHasProperty(manageGoalTool?.parameters, "objective")).toBe(true);
		expect(schemaHasProperty(manageGoalTool?.parameters, "reason")).toBe(true);
		expect(schemaHasProperty(manageGoalTool?.parameters, "tokenBudget")).toBe(false);
		expect(schemaHasProperty(manageGoalTool?.parameters, "wallClockMinutes")).toBe(false);
	});

	it("sets an objective only through the explicit /goal set subcommand", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set ship the goal feature");

		const goal = readStoredGoal<{ objective: string }>(cwd);
		expect(goal.objective).toBe("ship the goal feature");
		expect(harness.sendUserMessage).toHaveBeenCalledWith("Continue working toward the active goal.");
	});

	it("rejects a bare /goal objective instead of replacing durable state", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("continue");

		expect(storedGoalJsonBySession.has(storedGoalKey(cwd))).toBe(false);
		expect(harness.notify).toHaveBeenCalledWith("Use /goal set <objective> to set a goal", "error");
	});

	it("rejects reserved control words through manage_goal set", async () => {
		const harness = createGoalHarness(cwd);

		const result = await harness.runSetGoal("continue");

		expect(storedGoalJsonBySession.has(storedGoalKey(cwd))).toBe(false);
		expect(result?.content).toEqual([{ type: "text", text: "Objective cannot be a goal control command: continue" }]);
	});

	it("sets an objective through the manage_goal tool", async () => {
		const harness = createGoalHarness(cwd);

		const result = await harness.runSetGoal("ship tool parity");

		const goal = readStoredGoal<{ objective: string }>(cwd);
		expect(goal.objective).toBe("ship tool parity");
		expect(result?.content).toEqual([{ type: "text", text: "Goal set: ship tool parity" }]);
		expect(harness.sendUserMessage).toHaveBeenCalledWith("Continue working toward the active goal.");
	});

	it("replaces an active goal through the manage_goal tool", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set first objective");
		harness.notify.mockClear();
		harness.sendUserMessage.mockClear();
		const result = await harness.runSetGoal("agent-chosen objective");

		const goal = readStoredGoal<{ objective: string }>(cwd);
		expect(goal.objective).toBe("agent-chosen objective");
		expect(result?.content).toEqual([{ type: "text", text: "Goal set: agent-chosen objective" }]);
		expect(harness.notify).toHaveBeenCalledWith("Goal set — starting work", "info");
		expect(harness.sendUserMessage).toHaveBeenCalledWith("Continue working toward the active goal.");
	});

	it("sets an objective, persists it, and starts work when idle", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set ship the goal feature");

		const goal = readStoredGoal<{ objective: string }>(cwd);
		expect(goal.objective).toBe("ship the goal feature");
		expect(harness.notify).toHaveBeenCalledWith("Goal set — starting work", "info");
		expect(harness.sendUserMessage).toHaveBeenCalledWith("Continue working toward the active goal.");
	});

	it("reports busy goal saves as informational", async () => {
		const harness = createGoalHarness(cwd, { idle: false });

		await harness.runCommand("set guide the current run");

		expect(harness.notify).toHaveBeenCalledTimes(1);
		expect(harness.notify).toHaveBeenCalledWith("Goal saved — it will guide the current run", "info");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("migrates old project goal file into session storage", async () => {
		const legacyGoalFile = join(cwd, ".pi", "goal.json");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			legacyGoalFile,
			JSON.stringify({
				objective: "migrate old project objective",
				branch: "main",
				createdAt: "2026-01-01T00:00:00.000Z",
			}),
			"utf8",
		);
		const harness = createGoalHarness(cwd);

		await harness.runSessionStart("startup");

		const goal = readStoredGoal<{ objective: string }>(cwd);
		expect(goal.objective).toBe("migrate old project objective");
		expect(existsSync(legacyGoalFile)).toBe(false);
		expect(harness.notify).toHaveBeenCalledWith("Active goal: migrate old project objective", "info");
	});

	it("keeps active goals separate for two sessions in the same project", async () => {
		const firstHarness = createGoalHarness(cwd, { sessionId: "agent-one" });
		const secondHarness = createGoalHarness(cwd, { sessionId: "agent-two" });

		await firstHarness.runCommand("set first session objective");
		await secondHarness.runCommand("set second session objective");

		const firstPrompt = await firstHarness.runBeforeAgentStart();
		const secondPrompt = await secondHarness.runBeforeAgentStart();
		expect(firstPrompt?.systemPrompt).toContain("Long-running objective: first session objective");
		expect(firstPrompt?.systemPrompt).not.toContain("second session objective");
		expect(secondPrompt?.systemPrompt).toContain("Long-running objective: second session objective");
		expect(secondPrompt?.systemPrompt).not.toContain("first session objective");
	});

	it("replaces an active goal by default", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set first objective");
		harness.notify.mockClear();
		harness.sendUserMessage.mockClear();
		await harness.runCommand("set second objective");

		const goal = readStoredGoal<{ objective: string; continuationTurns: number }>(cwd);
		expect(goal.objective).toBe("second objective");
		expect(goal.continuationTurns).toBe(0);
		expect(harness.notify).toHaveBeenCalledWith("Goal set — starting work", "info");
		expect(harness.sendUserMessage).toHaveBeenCalledWith("Continue working toward the active goal.");
	});

	it("rejects the removed replacement flag", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand(`${"--"}replace second objective`);

		expect(storedGoalJsonBySession.has(storedGoalKey(cwd))).toBe(false);
		expect(harness.notify).toHaveBeenCalledWith("Goal flags are no longer supported", "error");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("injects the active objective into the system prompt", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set keep context anchored");

		const result = await harness.runBeforeAgentStart();
		expect(result?.systemPrompt).toContain("<goal>");
		expect(result?.systemPrompt).toContain("Long-running objective: keep context anchored");
		expect(result?.systemPrompt).toContain('When it is achieved, call the manage_goal tool with action "complete".');
		expect(result?.systemPrompt).toContain("base prompt");
	});

	it("injects continuation state without budget lines into the system prompt", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set continuation context");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd();

		const result = await harness.runBeforeAgentStart();
		expect(result?.systemPrompt).toContain("Continuation turns used: 1");
		expect(result?.systemPrompt).not.toContain("Token budget:");
		expect(result?.systemPrompt).not.toContain("Wall-clock budget:");
	});

	it("shows and clears the active objective", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set clearable objective");
		await harness.runCommand("");
		await harness.runCommand("clear");
		await harness.runCommand("");

		expect(harness.notify).toHaveBeenCalledWith("Goal: clearable objective", "info");
		expect(harness.notify).toHaveBeenCalledWith("Goal cleared", "info");
		expect(harness.notify).toHaveBeenCalledWith("No active goal — use /goal set <objective>", "info");
	});

	it("rejects objectives longer than the codex limit", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand(`set ${"x".repeat(4001)}`);

		expect(harness.notify).toHaveBeenCalledWith("Objective too long (4001 > 4000 chars)", "error");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("notifies when a persisted goal is restored on resume, reload, and fork", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set resume this objective");
		harness.notify.mockClear();
		await harness.runSessionStart("resume");
		await harness.runSessionStart("reload");
		await harness.runSessionStart("fork");

		expect(harness.notify).toHaveBeenCalledTimes(3);
		expect(harness.notify).toHaveBeenNthCalledWith(1, "Active goal: resume this objective", "info");
		expect(harness.notify).toHaveBeenNthCalledWith(2, "Active goal: resume this objective", "info");
		expect(harness.notify).toHaveBeenNthCalledWith(3, "Active goal: resume this objective", "info");
	});

	it("keeps a subagent goal independent from the parent goal", async () => {
		const parentSessionId = "parent-session";
		const childSessionId = "child-session";
		const parentHarness = createGoalHarness(cwd, { sessionId: parentSessionId });
		await parentHarness.runCommand("set parent objective");
		const previousSessionFile = join(cwd, "parent-session.jsonl");
		const parentSessionHeader = {
			type: "session",
			id: parentSessionId,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		};
		writeFileSync(previousSessionFile, `${JSON.stringify(parentSessionHeader)}\n`, "utf8");

		const childHarness = createGoalHarness(cwd, {
			sessionId: childSessionId,
			isSubagent: true,
			subagentName: "researcher",
		});
		await childHarness.runSessionStart("fork", previousSessionFile);
		await childHarness.runSetGoal("child objective");

		const parentPrompt = await parentHarness.runBeforeAgentStart();
		const childPrompt = await childHarness.runBeforeAgentStart();
		expect(parentPrompt?.systemPrompt).toContain("Long-running objective: parent objective");
		expect(parentPrompt?.systemPrompt).not.toContain("child objective");
		expect(childPrompt?.systemPrompt).toContain("Long-running objective: child objective");
		expect(childPrompt?.systemPrompt).not.toContain("parent objective");
	});

	it("inherits the parent goal when a fork starts with a new session id", async () => {
		const parentSessionId = "parent-session";
		const childSessionId = "child-session";
		const parentHarness = createGoalHarness(cwd, { sessionId: parentSessionId });
		await parentHarness.runCommand("set carry goal into fork");
		const previousSessionFile = join(cwd, "parent-session.jsonl");
		const parentSessionHeader = {
			type: "session",
			id: parentSessionId,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		};
		writeFileSync(previousSessionFile, `${JSON.stringify(parentSessionHeader)}\n`, "utf8");

		const childHarness = createGoalHarness(cwd, { sessionId: childSessionId });
		await childHarness.runSessionStart("fork", previousSessionFile);

		const inheritedGoal = readStoredGoal<{ objective: string }>(cwd, childSessionId);
		const childPrompt = await childHarness.runBeforeAgentStart();
		expect(inheritedGoal.objective).toBe("carry goal into fork");
		expect(childPrompt?.systemPrompt).toContain("Long-running objective: carry goal into fork");
		expect(childHarness.notify).toHaveBeenCalledWith("Active goal: carry goal into fork", "info");
	});

	it("does not inherit a previous session goal when resuming a different session", async () => {
		const previousSessionId = "session-a";
		const resumedSessionId = "session-b";
		const previousHarness = createGoalHarness(cwd, { sessionId: previousSessionId });
		await previousHarness.runCommand("set do not leak into resume");
		const previousSessionFile = join(cwd, "session-a.jsonl");
		const previousSessionHeader = {
			type: "session",
			id: previousSessionId,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		};
		writeFileSync(previousSessionFile, `${JSON.stringify(previousSessionHeader)}\n`, "utf8");

		const resumedHarness = createGoalHarness(cwd, { sessionId: resumedSessionId });
		await resumedHarness.runSessionStart("resume", previousSessionFile);

		const resumedPrompt = await resumedHarness.runBeforeAgentStart();
		expect(storedGoalJsonBySession.has(storedGoalKey(cwd, resumedSessionId))).toBe(false);
		expect(resumedPrompt).toBeUndefined();
		expect(resumedHarness.notify).not.toHaveBeenCalledWith("Active goal: do not leak into resume", "info");
	});

	it("treats corrupt goal state as no active objective", async () => {
		const harness = createGoalHarness(cwd);
		storedGoalJsonBySession.set(storedGoalKey(cwd), "{not json");

		await harness.runCommand("");
		const result = await harness.runBeforeAgentStart();

		expect(harness.notify).toHaveBeenCalledWith("No active goal — use /goal set <objective>", "info");
		expect(result).toBeUndefined();
	});

	it("treats goal state without an objective as no active objective", async () => {
		const harness = createGoalHarness(cwd);
		writeStoredGoal(cwd, "test-session", {
			description: "legacy goal",
			branch: "main",
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		await harness.runSessionStart("startup");
		await harness.runCommand("");
		const result = await harness.runBeforeAgentStart();

		expect(harness.notify).toHaveBeenCalledWith("No active goal — use /goal set <objective>", "info");
		expect(harness.notify).not.toHaveBeenCalledWith("Active goal: undefined", "info");
		expect(result).toBeUndefined();
	});

	it("treats completed goal state as no active objective", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set finish once");
		await harness.runGoalComplete("done");
		harness.notify.mockClear();
		const result = await harness.runBeforeAgentStart();
		await harness.runCommand("");

		expect(harness.notify).toHaveBeenCalledWith("No active goal — use /goal set <objective>", "info");
		expect(result).toBeUndefined();
	});

	it("gives resident goal reviews a three-minute deadline", async () => {
		const agentDir = join(cwd, "agent-dir");
		mkdirSync(agentDir, { recursive: true });
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const harness = createGoalHarness(cwd, { useResidentSupervisor: true });
			await harness.runCommand("set verify resident deadline");
			const review = harness.runAgentEnd();
			const controlDbPath = getControlDbPath(agentDir);
			let request = readSupervisorRequest(controlDbPath, 1);
			for (let attempts = 0; !request && attempts < 20; attempts++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				request = readSupervisorRequest(controlDbPath, 1);
			}
			if (!request) throw new Error("expected resident Supervisor request");
			const deadlineMs = Date.parse(request.deadlineAt) - Date.parse(request.createdAt);
			const claimed = claimNextSupervisorRequest(controlDbPath, "test-runtime");
			if (!claimed?.claimToken) throw new Error("expected claimed resident Supervisor request");
			completeSupervisorRequest(controlDbPath, claimed.id, claimed.claimToken, {
				kind: "complete",
				reason: "verified",
			});
			await review;
			expect(deadlineMs).toBeGreaterThanOrEqual(179_000);
			expect(deadlineMs).toBeLessThanOrEqual(180_000);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("continues an active goal after agent_end", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set continue this objective");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd();

		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			"Continue working toward this objective until it is achieved: continue this objective",
			{ deliverAs: "followUp" },
		);
	});

	it("continues after agent_end even before the runtime reports idle", async () => {
		const harness = createGoalHarness(cwd, { idle: false });

		await harness.runCommand("set continue from agent_end");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd();

		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			"Continue working toward this objective until it is achieved: continue from agent_end",
			{ deliverAs: "followUp" },
		);
	});

	it("does not queue a goal continuation when user input arrives during Supervisor review", async () => {
		let hasPendingMessages = false;
		let finishReview: (() => void) | undefined;
		let markReviewStarted: (() => void) | undefined;
		const reviewStarted = new Promise<void>((resolve) => {
			markReviewStarted = resolve;
		});
		const harness = createGoalHarness(cwd, {
			hasPendingMessages: () => hasPendingMessages,
			reviewGoal: async () => {
				markReviewStarted?.();
				await new Promise<void>((resolve) => {
					finishReview = resolve;
				});
				return { kind: "continue", reason: "work remains", instructions: "goal continuation" };
			},
		});

		await harness.runCommand("set wait for queued user input");
		harness.sendUserMessage.mockClear();
		const agentEnd = harness.runAgentEnd();
		await reviewStarted;
		hasPendingMessages = true;
		finishReview?.();
		await agentEnd;

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(readStoredGoal<{ continuationTurns: number }>(cwd).continuationTurns).toBe(0);
	});

	it("keeps the goal running and follows Supervisor instructions when completion is rejected", async () => {
		const harness = createGoalHarness(cwd, {
			reviewGoal: async () => ({ kind: "continue", reason: "proof missing", instructions: "Run npm test." }),
		});
		await harness.runCommand("set complete explicitly");
		harness.sendUserMessage.mockClear();

		const result = await harness.runGoalComplete("done");

		expect(result?.content).toEqual([{ type: "text", text: "Goal remains active: proof missing" }]);
		expect(harness.sendUserMessage).toHaveBeenCalledWith("Run npm test.", { deliverAs: "followUp" });
		expect(await harness.runBeforeAgentStart()).toBeDefined();
	});

	it("lets the Supervisor complete a running goal at the existing agent_end continuation point", async () => {
		const harness = createGoalHarness(cwd, {
			reviewGoal: async () => ({ kind: "complete", reason: "all evidence passed" }),
		});
		await harness.runCommand("set finish automatically");
		harness.sendUserMessage.mockClear();

		await harness.runAgentEnd();

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(await harness.runBeforeAgentStart()).toBeUndefined();
	});

	it("keeps a goal running without continuing automatically after Supervisor error", async () => {
		const harness = createGoalHarness(cwd, {
			reviewGoal: async () => ({ kind: "error", reason: "service failed" }),
		});
		await harness.runCommand("set survive review error");
		harness.sendUserMessage.mockClear();

		await harness.runAgentEnd();

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith("Supervisor goal review failed: service failed", "error");
		expect(await harness.runBeforeAgentStart()).toBeDefined();
	});

	it("stops continuation after manage_goal completes the objective", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set complete explicitly");
		const result = await harness.runGoalComplete("done");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd();

		expect(result?.content).toEqual([{ type: "text", text: "Goal marked complete: done" }]);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not complete a goal twice through manage_goal", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set complete once");
		await harness.runGoalComplete("done");
		const result = await harness.runGoalComplete("again");

		expect(result?.content).toEqual([{ type: "text", text: "No active goal to complete." }]);
	});

	it("pauses an active goal through the manage_goal tool", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set pause by tool objective");
		harness.notify.mockClear();
		harness.sendUserMessage.mockClear();
		harness.setStatus.mockClear();
		const result = await harness.runPauseGoal();
		const injected = await harness.runBeforeAgentStart();
		await harness.runAgentEnd();

		const goal = readStoredGoal<{ objective: string; pausedAt?: string }>(cwd);
		expect(goal.objective).toBe("pause by tool objective");
		expect(goal.pausedAt).toEqual(expect.any(String));
		expect(result?.content).toEqual([{ type: "text", text: "Goal paused: pause by tool objective" }]);
		expect(harness.notify).toHaveBeenCalledWith("Goal paused: pause by tool objective", "info");
		expect(harness.setStatus).toHaveBeenCalledWith("goal", "goal paused: pause by tool objective");
		expect(injected).toBeUndefined();
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not pause through the manage_goal tool when no active goal exists", async () => {
		const harness = createGoalHarness(cwd);

		const result = await harness.runPauseGoal();

		expect(storedGoalJsonBySession.has(storedGoalKey(cwd))).toBe(false);
		expect(result?.content).toEqual([{ type: "text", text: "No active goal to pause." }]);
		expect(harness.notify).toHaveBeenCalledWith("No active goal to pause", "info");
	});

	it("pauses an active goal without clearing it", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set pause retained objective");
		harness.notify.mockClear();
		harness.sendUserMessage.mockClear();
		harness.setStatus.mockClear();
		await harness.runCommand("pause");
		await harness.runCommand("");
		const injected = await harness.runBeforeAgentStart();
		await harness.runAgentEnd();

		const goal = readStoredGoal<{ objective: string; pausedAt?: string }>(cwd);
		expect(goal.objective).toBe("pause retained objective");
		expect(goal.pausedAt).toEqual(expect.any(String));
		expect(harness.notify).toHaveBeenNthCalledWith(1, "Goal paused: pause retained objective", "info");
		expect(harness.notify).toHaveBeenNthCalledWith(2, "Goal paused: pause retained objective", "info");
		expect(harness.setStatus).toHaveBeenCalledWith("goal", "goal paused: pause retained objective");
		expect(injected).toBeUndefined();
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("resumes a paused goal without replacing it", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set resume retained objective");
		await harness.runCommand("pause");
		harness.notify.mockClear();
		harness.sendUserMessage.mockClear();
		harness.setStatus.mockClear();
		await harness.runCommand("resume");
		const injected = await harness.runBeforeAgentStart();

		const goal = readStoredGoal<{ objective: string; pausedAt?: string }>(cwd);
		expect(goal.objective).toBe("resume retained objective");
		expect(goal.pausedAt).toBeUndefined();
		expect(harness.notify).toHaveBeenCalledWith("Goal resumed: resume retained objective", "info");
		expect(harness.setStatus).toHaveBeenCalledWith("goal", "goal: resume retained objective");
		expect(harness.sendUserMessage).toHaveBeenCalledWith("Continue working toward the active goal.");
		expect(injected?.systemPrompt).toContain("Long-running objective: resume retained objective");
	});

	it("does not resume when no paused goal exists", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("resume");

		expect(storedGoalJsonBySession.has(storedGoalKey(cwd))).toBe(false);
		expect(harness.notify).toHaveBeenCalledWith("No paused goal to resume", "info");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("clears a paused goal", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set clear paused objective");
		await harness.runCommand("pause");
		await harness.runCommand("clear");
		await harness.runCommand("");

		expect(storedGoalJsonBySession.has(storedGoalKey(cwd))).toBe(false);
		expect(harness.notify).toHaveBeenCalledWith("Goal cleared", "info");
		expect(harness.notify).toHaveBeenCalledWith("No active goal — use /goal set <objective>", "info");
	});

	it("does not pause when no active goal exists", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("pause");

		expect(storedGoalJsonBySession.has(storedGoalKey(cwd))).toBe(false);
		expect(harness.notify).toHaveBeenCalledWith("No active goal to pause", "info");
	});

	it("continues without a numeric turn cap", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set long running continuation");
		harness.sendUserMessage.mockClear();
		for (let i = 0; i < 100; i++) {
			await harness.runAgentEnd();
		}

		expect(harness.sendUserMessage).toHaveBeenCalledTimes(100);
		expect(harness.notify).not.toHaveBeenCalledWith(expect.stringContaining("turn cap"), "warning");
	});

	it("stops continuation when the last assistant response is empty", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set empty response bounded");
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd([createAssistantMessage("   ")]);

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			"Goal continuation stopped because the last assistant response was empty",
			"warning",
		);
	});

	it("does not continue or warn when the last assistant response is an error", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set retry failed request");
		harness.notify.mockClear();
		harness.sendUserMessage.mockClear();
		await harness.runAgentEnd([createAssistantMessage("", "error")]);
		const goal = readStoredGoal<{ objective: string; pausedAt?: string }>(cwd);
		const nextTurn = await harness.runBeforeAgentStart();

		expect(goal.objective).toBe("retry failed request");
		expect(goal.pausedAt).toBeUndefined();
		expect(nextTurn?.systemPrompt).toContain("Long-running objective: retry failed request");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).not.toHaveBeenCalled();
	});

	it("pauses the active goal when the agent turn is aborted", async () => {
		const harness = createGoalHarness(cwd, { hasPendingMessages: true });

		await harness.runCommand("set pause on abort");
		harness.notify.mockClear();
		harness.sendUserMessage.mockClear();
		harness.setStatus.mockClear();
		await harness.runAgentEnd([createAssistantMessage("", "aborted")]);

		const goal = readStoredGoal<{ objective: string; pausedAt?: string }>(cwd);
		expect(goal.objective).toBe("pause on abort");
		expect(goal.pausedAt).toEqual(expect.any(String));
		expect(harness.setStatus).toHaveBeenCalledWith("goal", "goal paused: pause on abort");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).not.toHaveBeenCalledWith(
			"Goal continuation stopped because the last assistant response was empty",
			"warning",
		);
	});

	it("persists new goals without budget fields", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set plain objective");

		const goal = readStoredGoal<Record<string, unknown>>(cwd);
		expect(goal.objective).toBe("plain objective");
		expect(goal).not.toHaveProperty("tokenBudget");
		expect(goal).not.toHaveProperty("wallClockBudgetMs");
	});

	it("rejects the token budget flag", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("--token-budget 100 rejected objective");

		expect(storedGoalJsonBySession.has(storedGoalKey(cwd))).toBe(false);
		expect(harness.notify).toHaveBeenCalledWith("/goal --token-budget is no longer supported", "error");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("rejects the wall-clock budget flag", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("--wall-clock-minutes 5 rejected objective");

		expect(storedGoalJsonBySession.has(storedGoalKey(cwd))).toBe(false);
		expect(harness.notify).toHaveBeenCalledWith("/goal --wall-clock-minutes is no longer supported", "error");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("shows the active goal in the footer status", async () => {
		const harness = createGoalHarness(cwd);

		await harness.runCommand("set visible footer objective");
		await harness.runCommand("clear");

		expect(harness.setStatus).toHaveBeenCalledWith("goal", "goal: visible footer objective");
		expect(harness.setStatus).toHaveBeenCalledWith("goal", undefined);
	});

	it("ignores legacy budget fields when continuing", async () => {
		const harness = createGoalHarness(cwd, { contextUsage: { tokens: 101, contextWindow: 1000, percent: 10.1 } });
		writeStoredGoal(cwd, "test-session", {
			objective: "legacy budget objective",
			branch: "main",
			createdAt: "2000-01-01T00:00:00.000Z",
			continuationTurns: 0,
			tokenBudget: 100,
			wallClockBudgetMs: 60 * 1000,
		});

		await harness.runAgentEnd();

		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			"Continue working toward this objective until it is achieved: legacy budget objective",
			{ deliverAs: "followUp" },
		);
		expect(harness.notify).not.toHaveBeenCalledWith(expect.stringContaining("budget"), "warning");
	});
});
