import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManageGoalParams } from "../extensions/goal/src/goal-tool.ts";
import goalExtension, { type Goal, type GoalSupervisorReview } from "../extensions/goal/src/index.ts";
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
import { SessionManager } from "../src/core/session-manager.ts";

const model = getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Test model not found");

const REMINDER = "Continue working toward the active goal.";
const INSTRUCTIONS = "Fix the failing service first.";
const REVIEW_DELAY_MS = 1_000;
const COMPLETION_WAIT_MS = 55 * 60 * 1_000;

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type Handler = ExtensionHandler<never, unknown>;

interface SessionStore {
	entries: { type: "custom"; customType: string; data: unknown }[];
	goalJson?: string;
	sessionManager?: SessionManager;
}

function assistantTurn(text: string): AssistantMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	];
}

const continueReview: GoalSupervisorReview = async ({ kind }) =>
	kind === "goal_completion_review"
		? { kind: "complete", reason: "verified" }
		: { kind: "continue", reason: "work remains", instructions: INSTRUCTIONS };

function idleReviewOf(objective: string) {
	return expect.objectContaining({ kind: "goal_idle_review", payload: expect.objectContaining({ objective }) });
}

function supervisorInstructions(instructions: string) {
	return [
		expect.objectContaining({ content: `<supervisor-instruction>\n${instructions}\n</supervisor-instruction>` }),
		{ deliverAs: "followUp", triggerTurn: true },
	] as const;
}

function createMissionHarness(store: SessionStore = { entries: [] }, reviewGoal = continueReview) {
	const commands = new Map<string, Command>();
	const handlers = new Map<string, Handler>();
	const toolNames: string[] = [];
	let manageGoalTool: ToolDefinition | undefined;
	const sendUserMessage = vi.fn();
	const sendMessage = vi.fn();
	const setStatus = vi.fn();
	const notify = vi.fn();
	const requestResumeContinuation = vi.fn();
	let idle = true;
	const pi = {
		appendEntry: (customType: string, data?: unknown) => {
			if (store.sessionManager) store.sessionManager.appendCustomEntry(customType, data);
			else store.entries.push({ type: "custom", customType, data });
		},
		callTool: async () => ({ content: [], details: { activeCount: 0 } }),
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerEntryRenderer: () => {},
		registerMessageRenderer: () => {},
		registerTool: (tool: ToolDefinition) => {
			toolNames.push(tool.name);
			if (tool.name === "manage_goal") manageGoalTool = tool;
		},
		requestResumeContinuation,
		sendMessage,
		sendUserMessage,
	} as unknown as ExtensionAPI;
	goalExtension(pi, { reviewGoal });

	const ctx = {
		cwd: process.cwd(),
		ui: { notify, requestRender: () => {}, setStatus },
		sessionManager: store.sessionManager ?? {
			getEntries: () => store.entries,
			getSessionId: () => "mission-session",
			getSessionGoalJson: () => store.goalJson,
			setSessionGoalJson: (goalJson: string) => {
				store.goalJson = goalJson;
			},
			clearSessionGoalJson: () => {
				store.goalJson = undefined;
			},
			isSubagentSession: () => false,
		},
		isIdle: () => idle,
		hasActiveRetry: () => false,
		hasPendingMessages: () => false,
	} as unknown as ExtensionCommandContext;

	const emit = async <TEvent>(event: string, payload: TEvent) =>
		(handlers.get(event) as ExtensionHandler<TEvent, unknown> | undefined)?.(payload, ctx as ExtensionContext);

	return {
		toolNames,
		setIdle: (isIdle: boolean) => {
			idle = isIdle;
		},
		sendUserMessage,
		sendMessage,
		setStatus,
		requestResumeContinuation,
		goal: (): Goal | undefined => {
			const goalJson = store.sessionManager?.getSessionGoalJson() ?? store.goalJson;
			return goalJson ? (JSON.parse(goalJson) as Goal) : undefined;
		},
		command: async (name: string, args: string) => commands.get(name)?.handler(args, ctx),
		manageGoal: async (params: ManageGoalParams) =>
			manageGoalTool?.execute("manage-goal", params, undefined, undefined, ctx as ExtensionContext),
		// agent_end handlers run before the run becomes idle.
		agentEnd: async (text = "done for now") => {
			idle = false;
			await emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: assistantTurn(text) });
			idle = true;
		},
		sessionStart: async () => emit<SessionStartEvent>("session_start", { type: "session_start", reason: "resume" }),
		systemPrompt: async () =>
			(await emit<BeforeAgentStartEvent>("before_agent_start", {
				type: "before_agent_start",
				prompt: "prompt",
				images: undefined,
				systemPrompt: "base",
				systemPromptOptions: { cwd: process.cwd(), contextFiles: [], skills: [] },
			})) as BeforeAgentStartEventResult | undefined,
	};
}

describe("goal extension mission", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("copies a new mission into a never-completable goal and starts work through Supervisor review", async () => {
		const reviewGoal = vi.fn<GoalSupervisorReview>(continueReview);
		const harness = createMissionHarness({ entries: [] }, reviewGoal);

		await harness.command("mission", "set keep the test suite green");

		expect(harness.goal()).toMatchObject({ objective: "keep the test suite green", mission: true });
		expect(harness.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(REVIEW_DELAY_MS);
		expect(reviewGoal).toHaveBeenCalledExactlyOnceWith(idleReviewOf("keep the test suite green"));
		expect(harness.sendMessage).toHaveBeenCalledExactlyOnceWith(...supervisorInstructions(INSTRUCTIONS));
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.setStatus).toHaveBeenCalledWith("mission", "mission: keep the test suite green");
		const prompt = (await harness.systemPrompt())?.systemPrompt ?? "";
		expect(prompt).toContain("It is never complete; only the user stops it.");
		expect(prompt).not.toContain('action "complete"');
	});

	it("exposes the mission only through the /mission command, not as a tool", () => {
		expect(createMissionHarness().toolNames).toEqual(["manage_goal"]);
	});

	it("keeps a running user goal and resumes the mission when that goal completes", async () => {
		const harness = createMissionHarness();
		await harness.command("goal", "set ship the parser");
		await harness.command("mission", "set maintain the compiler");
		expect(harness.goal()).toMatchObject({ objective: "ship the parser" });
		harness.sendUserMessage.mockClear();
		harness.setIdle(false);

		await harness.manageGoal({ action: "complete", completionReport: "Parser shipped and tested." });

		expect(harness.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
		expect(harness.goal()?.completedAt).toBeUndefined();
		await vi.advanceTimersByTimeAsync(REVIEW_DELAY_MS);
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.sendMessage).not.toHaveBeenCalled();

		await harness.agentEnd();

		expect(harness.sendMessage).toHaveBeenCalledExactlyOnceWith(...supervisorInstructions(INSTRUCTIONS));
	});

	it("queues nothing when manage_goal stops the goal repeatedly in one run", async () => {
		const reviewGoal = vi.fn<GoalSupervisorReview>(continueReview);
		const harness = createMissionHarness({ entries: [] }, reviewGoal);
		harness.setIdle(false);
		await harness.command("mission", "set maintain the compiler");

		await harness.manageGoal({ action: "pause", reason: "Need the user to decide." });
		await harness.manageGoal({ action: "clear" });
		await harness.manageGoal({ action: "pause", reason: "Blocked on review." });
		await vi.advanceTimersByTimeAsync(COMPLETION_WAIT_MS);

		expect(harness.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
		expect(harness.goal()?.pausedAt).toBeUndefined();
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.sendMessage).not.toHaveBeenCalled();
		expect(reviewGoal).not.toHaveBeenCalled();

		await harness.agentEnd();

		expect(reviewGoal).toHaveBeenCalledExactlyOnceWith(idleReviewOf("maintain the compiler"));
		expect(harness.sendMessage).toHaveBeenCalledExactlyOnceWith(...supervisorInstructions(INSTRUCTIONS));
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("reviews the mission after the Supervisor completes a user goal at agent_end", async () => {
		const reviewGoal = vi.fn<GoalSupervisorReview>(async ({ payload }) =>
			payload.objective === "ship the parser"
				? { kind: "complete", reason: "proven" }
				: { kind: "continue", reason: "work remains", instructions: INSTRUCTIONS },
		);
		const harness = createMissionHarness({ entries: [] }, reviewGoal);
		await harness.command("goal", "set ship the parser");
		await harness.command("mission", "set maintain the compiler");
		harness.sendUserMessage.mockClear();

		await harness.agentEnd();

		expect(harness.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
		expect(harness.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(REVIEW_DELAY_MS);
		expect(reviewGoal).toHaveBeenLastCalledWith(idleReviewOf("maintain the compiler"));
		expect(harness.sendMessage).toHaveBeenCalledExactlyOnceWith(...supervisorInstructions(INSTRUCTIONS));
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("reviews the mission after a waiting completion review completes a user goal on an idle session", async () => {
		let completionReviews = 0;
		const reviewGoal = vi.fn<GoalSupervisorReview>(async ({ kind }) => {
			if (kind !== "goal_completion_review") {
				return { kind: "continue", reason: "work remains", instructions: INSTRUCTIONS };
			}
			completionReviews++;
			return completionReviews === 1
				? { kind: "wait", reason: "deployment is still rolling out" }
				: { kind: "complete", reason: "deployment verified" };
		});
		const harness = createMissionHarness({ entries: [] }, reviewGoal);
		await harness.command("goal", "set ship the parser");
		await harness.command("mission", "set maintain the compiler");
		harness.sendUserMessage.mockClear();
		harness.setIdle(false);
		await harness.manageGoal({ action: "complete", completionReport: "Parser shipped and tested." });
		harness.setIdle(true);

		await vi.advanceTimersByTimeAsync(COMPLETION_WAIT_MS);

		expect(harness.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
		expect(harness.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(REVIEW_DELAY_MS);
		expect(reviewGoal).toHaveBeenLastCalledWith(idleReviewOf("maintain the compiler"));
		expect(harness.sendMessage).toHaveBeenCalledExactlyOnceWith(...supervisorInstructions(INSTRUCTIONS));
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("reviews the mission after /goal clear on an idle session", async () => {
		const reviewGoal = vi.fn<GoalSupervisorReview>(continueReview);
		const harness = createMissionHarness({ entries: [] }, reviewGoal);
		await harness.command("mission", "set maintain the compiler");
		await vi.advanceTimersByTimeAsync(REVIEW_DELAY_MS);
		const firstMissionGoal = harness.goal();
		reviewGoal.mockClear();
		harness.sendMessage.mockClear();

		await harness.command("goal", "clear");
		await vi.advanceTimersByTimeAsync(REVIEW_DELAY_MS);

		expect(harness.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
		expect(harness.goal()?.createdAt).not.toBe(firstMissionGoal?.createdAt);
		expect(reviewGoal).toHaveBeenCalledExactlyOnceWith(idleReviewOf("maintain the compiler"));
		expect(harness.sendMessage).toHaveBeenCalledExactlyOnceWith(...supervisorInstructions(INSTRUCTIONS));
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("rejects model completion of a mission goal and continues when the Supervisor says complete", async () => {
		const harness = createMissionHarness({ entries: [] }, async () => ({ kind: "complete", reason: "looks done" }));
		await harness.command("mission", "set maintain the compiler");
		const missionGoal = harness.goal();

		const result = await harness.manageGoal({ action: "complete", completionReport: "All done." });
		expect(result?.content).toEqual([
			{ type: "text", text: "Mission goals are continuous; only the user stops a mission." },
		]);
		expect(harness.goal()).toEqual(missionGoal);

		await harness.agentEnd();

		expect(harness.goal()).toMatchObject({ createdAt: missionGoal?.createdAt, continuationTurns: 1 });
		expect(harness.goal()?.completedAt).toBeUndefined();
		expect(harness.sendMessage).toHaveBeenLastCalledWith(...supervisorInstructions(REMINDER));
	});

	it.each<ManageGoalParams>([{ action: "pause", reason: "Need the user to decide." }, { action: "clear" }])(
		"replaces the goal with the mission after manage_goal $action",
		async (params) => {
			const harness = createMissionHarness();
			await harness.command("mission", "set maintain the compiler");

			await harness.manageGoal(params);

			expect(harness.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
			expect(harness.goal()?.pausedAt).toBeUndefined();
		},
	);

	it("leaves a goal paused by the user paused", async () => {
		const harness = createMissionHarness();
		await harness.command("mission", "set maintain the compiler");
		await harness.command("goal", "pause");

		await harness.sessionStart();

		expect(harness.goal()).toMatchObject({ mission: true, pauseReason: "Paused by user." });
		expect(harness.requestResumeContinuation).not.toHaveBeenCalled();
	});

	it("stops only through /mission pause and /mission clear", async () => {
		const harness = createMissionHarness();
		await harness.command("mission", "set maintain the compiler");

		await harness.command("mission", "pause");
		expect(harness.goal()).toMatchObject({ mission: true, pauseReason: "Mission paused by user." });
		expect(harness.setStatus).toHaveBeenCalledWith("mission", "mission paused: maintain the compiler");
		await vi.advanceTimersByTimeAsync(REVIEW_DELAY_MS);
		expect(harness.sendMessage).not.toHaveBeenCalled();

		await harness.command("mission", "resume");
		expect(harness.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
		expect(harness.goal()?.pausedAt).toBeUndefined();
		await vi.advanceTimersByTimeAsync(REVIEW_DELAY_MS);
		expect(harness.sendMessage).toHaveBeenCalledExactlyOnceWith(...supervisorInstructions(INSTRUCTIONS));
		expect(harness.sendUserMessage).not.toHaveBeenCalled();

		await harness.command("mission", "clear");
		expect(harness.goal()).toBeUndefined();
		expect(harness.setStatus).toHaveBeenNthCalledWith(harness.setStatus.mock.calls.length - 1, "mission", undefined);
		await harness.manageGoal({ action: "clear" });
		expect(harness.goal()).toBeUndefined();
	});

	it.each([
		{ action: "set", expectedStatus: "mission: maintain the compiler" },
		{ action: "pause", expectedStatus: "mission paused: maintain the compiler" },
		{ action: "clear", expectedStatus: undefined },
	])("restores the latest $action mission state after compaction and reopen", async ({ action, expectedStatus }) => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-mission-restore-"));
		try {
			const original = SessionManager.create(process.cwd(), sessionDir);
			original.appendMessage(assistantTurn("start")[0]!);
			const initialHarness = createMissionHarness({ entries: [], sessionManager: original });
			await initialHarness.command("mission", "set maintain the compiler");
			if (action === "pause") await initialHarness.command("mission", "pause");
			if (action === "clear") await initialHarness.command("mission", "clear");
			const keptEntryId = original.appendMessage({ role: "user", content: "kept after compaction", timestamp: 2 });
			original.appendCompaction("Older context summarized", keptEntryId, 100);
			original.persistForRecovery();

			const reopened = SessionManager.open(original.getSessionFile()!);
			expect(reopened.getEntries().some((entry) => entry.type === "custom" && entry.customType === "mission")).toBe(
				false,
			);
			const restarted = createMissionHarness({ entries: [], sessionManager: reopened });
			await restarted.sessionStart();

			if (action === "pause" || action === "clear") expect(restarted.goal()).toBeUndefined();
			else expect(restarted.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
			expect(restarted.setStatus).toHaveBeenCalledWith("mission", expectedStatus);
			if (action === "pause") {
				await restarted.command("mission", "resume");
				expect(restarted.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
			}
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("restores a compacted mission without replacing a running working goal", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-mission-working-goal-"));
		try {
			const original = SessionManager.create(process.cwd(), sessionDir);
			original.appendMessage(assistantTurn("start")[0]!);
			await createMissionHarness({ entries: [], sessionManager: original }).command(
				"mission",
				"set maintain the compiler",
			);
			const keptEntryId = original.appendMessage({ role: "user", content: "kept after compaction", timestamp: 2 });
			original.appendCompaction("Older context summarized", keptEntryId, 100);
			original.persistForRecovery();

			const reopened = SessionManager.open(original.getSessionFile()!);
			const workingGoal: Goal = {
				objective: "ship the parser",
				branch: "master",
				createdAt: new Date().toISOString(),
				continuationTurns: 0,
			};
			reopened.setSessionGoalJson(JSON.stringify(workingGoal));
			const restarted = createMissionHarness({ entries: [], sessionManager: reopened });
			await restarted.sessionStart();

			expect(restarted.goal()).toEqual(workingGoal);
			expect(restarted.setStatus).toHaveBeenCalledWith("mission", "mission: maintain the compiler");
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
