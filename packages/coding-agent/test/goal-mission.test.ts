import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
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

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type Handler = ExtensionHandler<never, unknown>;

interface SessionStore {
	entries: { type: "custom"; customType: string; data: unknown }[];
	goalJson?: string;
	sessionManager?: SessionManager;
}

function assistantTurn(text: string): AgentEndEvent["messages"] {
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
		: { kind: "continue", reason: "work remains", instructions: REMINDER };

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
	const pi = {
		appendEntry: (customType: string, data?: unknown) => {
			if (store.sessionManager) store.sessionManager.appendCustomEntry(customType, data);
			else store.entries.push({ type: "custom", customType, data });
		},
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
		isIdle: () => true,
		hasActiveRetry: () => false,
		hasPendingMessages: () => false,
	} as unknown as ExtensionCommandContext;

	const emit = async <TEvent>(event: string, payload: TEvent) =>
		(handlers.get(event) as ExtensionHandler<TEvent, unknown> | undefined)?.(payload, ctx as ExtensionContext);

	return {
		toolNames,
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
		agentEnd: async (text = "done for now") =>
			emit<AgentEndEvent>("agent_end", { type: "agent_end", messages: assistantTurn(text) }),
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
	it("copies a new mission into a never-completable goal and starts work", async () => {
		const harness = createMissionHarness();

		await harness.command("mission", "set keep the test suite green");

		expect(harness.goal()).toMatchObject({ objective: "keep the test suite green", mission: true });
		expect(harness.sendUserMessage).toHaveBeenCalledExactlyOnceWith(REMINDER, { deliverAs: "followUp" });
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

		await harness.manageGoal({ action: "complete", completionReport: "Parser shipped and tested." });

		expect(harness.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
		expect(harness.goal()?.completedAt).toBeUndefined();
		expect(harness.sendUserMessage).toHaveBeenCalledExactlyOnceWith(REMINDER, { deliverAs: "followUp" });
	});

	it("resumes the mission when the Supervisor completes a user goal at agent_end", async () => {
		const harness = createMissionHarness({ entries: [] }, async () => ({ kind: "complete", reason: "proven" }));
		await harness.command("goal", "set ship the parser");
		await harness.command("mission", "set maintain the compiler");

		await harness.agentEnd();

		expect(harness.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
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
		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: `<supervisor-instruction>\n${REMINDER}\n</supervisor-instruction>` }),
			{ deliverAs: "followUp", triggerTurn: true },
		);
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
		harness.sendUserMessage.mockClear();

		await harness.command("mission", "resume");
		expect(harness.goal()).toMatchObject({ objective: "maintain the compiler", mission: true });
		expect(harness.goal()?.pausedAt).toBeUndefined();
		expect(harness.sendUserMessage).toHaveBeenCalledExactlyOnceWith(REMINDER, { deliverAs: "followUp" });

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
