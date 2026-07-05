/**
 * Goal System (`/goal`)
 *
 * Sets or views the objective for a long-running task (modeled on codex's
 * `/goal`). A goal is a persistent objective string — NOT a checklist of gates.
 * Once set, the agent starts working toward it, and the objective is injected
 * into the system prompt every turn so it stays anchored across the run and
 * across resume.
 *
 * State is persisted as JSON in the control SQLite `session_metadata` row for the session.
 *
 * Commands:
 *   /goal <objective>             set the objective and start working toward it
 *   /goal                         view the active objective
 *   /goal pause                   pause continuation without clearing the objective
 *   /goal clear                   clear the active objective
 *
 * See docs/specs/goal-system.md for the contract.
 *
 * Continuation is implemented below; remaining delivery work is tracked in
 * docs/specs/goal-system.md.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** codex caps the objective at 4000 characters. */
const MAX_OBJECTIVE_CHARS = 4000;

interface Goal {
	objective: string;
	branch: string;
	createdAt: string;
	completedAt?: string;
	completionReason?: string;
	continuationTurns?: number;
	pausedAt?: string;
}

interface ParsedGoalArgs {
	objective: string;
}

interface SetGoalParams extends ParsedGoalArgs {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
}

function goalPathForSessionId(cwd: string, sessionId: string): string {
	return path.join(cwd, ".pi", "goals", `${encodeURIComponent(sessionId)}.json`);
}

function goalPath(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
	return goalPathForSessionId(ctx.cwd, ctx.sessionManager.getSessionId());
}

function oldProjectGoalPath(cwd: string): string {
	return path.join(cwd, ".pi", "goal.json");
}

function saveGoalJson(ctx: Pick<ExtensionContext, "sessionManager">, goal: Goal): void {
	ctx.sessionManager.setSessionGoalJson(`${JSON.stringify(goal)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseGoal(value: unknown): Goal | null {
	if (!isRecord(value)) return null;
	const objective = optionalString(value.objective)?.trim();
	const branch = optionalString(value.branch);
	const createdAt = optionalString(value.createdAt);
	if (!objective || !branch || !createdAt) return null;

	return {
		objective,
		branch,
		createdAt,
		completedAt: optionalString(value.completedAt),
		completionReason: optionalString(value.completionReason),
		continuationTurns: optionalNumber(value.continuationTurns),
		pausedAt: optionalString(value.pausedAt),
	};
}

function loadGoalFile(file: string): Goal | null {
	if (!fs.existsSync(file)) return null;
	try {
		return parseGoal(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

function loadGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const storedGoal = ctx.sessionManager.getSessionGoalJson();
	if (storedGoal) return parseGoalJson(storedGoal);
	return migrateLegacyGoal(ctx);
}

function loadActiveGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const goal = loadGoal(ctx);
	return goal && !goal.completedAt ? goal : null;
}

function loadRunningGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const goal = loadActiveGoal(ctx);
	return goal && !goal.pausedAt ? goal : null;
}

function parseGoalJson(value: string): Goal | null {
	try {
		return parseGoal(JSON.parse(value));
	} catch {
		return null;
	}
}

function migrateLegacyGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	for (const file of [goalPath(ctx), oldProjectGoalPath(ctx.cwd)]) {
		const goal = loadGoalFile(file);
		if (!goal) continue;
		saveGoalJson(ctx, goal);
		fs.rmSync(file);
		return goal;
	}
	return null;
}

function saveGoal(ctx: Pick<ExtensionContext, "sessionManager">, goal: Goal): void {
	saveGoalJson(ctx, goal);
}

function markGoalComplete(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, reason: string): Goal | null {
	const goal = loadGoal(ctx);
	if (!goal) return null;
	const completedGoal: Goal = {
		...goal,
		completedAt: new Date().toISOString(),
		completionReason: reason,
	};
	saveGoal(ctx, completedGoal);
	return completedGoal;
}

function pauseGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const goal = loadActiveGoal(ctx);
	if (!goal) return null;
	if (goal.pausedAt) return goal;
	const pausedGoal: Goal = {
		...goal,
		pausedAt: new Date().toISOString(),
	};
	saveGoal(ctx, pausedGoal);
	return pausedGoal;
}

function clearGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): boolean {
	const hasStoredGoal = ctx.sessionManager.getSessionGoalJson() !== undefined;
	const legacyFile = goalPath(ctx);
	const hasLegacyGoal = fs.existsSync(legacyFile);
	ctx.sessionManager.clearSessionGoalJson();
	if (hasLegacyGoal) {
		fs.rmSync(legacyFile);
	}
	return hasStoredGoal || hasLegacyGoal;
}

function goalFooterStatus(goal: Goal): string {
	return goal.pausedAt ? `goal paused: ${goal.objective}` : `goal: ${goal.objective}`;
}

function goalStartupMessage(goal: Goal): string {
	return goal.pausedAt ? `Paused goal: ${goal.objective}` : `Active goal: ${goal.objective}`;
}

function goalViewMessage(goal: Goal): string {
	return goal.pausedAt ? `Goal paused: ${goal.objective}` : `Goal: ${goal.objective}`;
}

function updateGoalFooterStatus(ctx: ExtensionContext): void {
	const goal = loadActiveGoal(ctx);
	ctx.ui.setStatus("goal", goal ? goalFooterStatus(goal) : undefined);
}

function parseGoalArgs(args: string): ParsedGoalArgs | { error: string } {
	const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
	const objectiveParts: string[] = [];

	for (const part of parts) {
		if (part === "--token-budget" || part.startsWith("--token-budget=")) {
			return { error: "/goal --token-budget is no longer supported" };
		}
		if (part === "--wall-clock-minutes" || part.startsWith("--wall-clock-minutes=")) {
			return { error: "/goal --wall-clock-minutes is no longer supported" };
		}
		if (part.startsWith("--")) {
			return { error: "Goal flags are no longer supported" };
		}
		objectiveParts.push(part);
	}

	return { objective: objectiveParts.join(" ") };
}

function goalStateLines(goal: Goal): string[] {
	return [`Continuation turns used: ${goal.continuationTurns ?? 0}`];
}

function currentBranch(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "(no branch)";
	}
}

function sessionIdFromSessionFile(sessionFile: string): string | null {
	try {
		const [firstLine] = fs.readFileSync(sessionFile, "utf8").split("\n", 1);
		const entry = JSON.parse(firstLine ?? "");
		return isRecord(entry) ? optionalString(entry.id) ?? null : null;
	} catch {
		return null;
	}
}

function inheritPreviousSessionGoal(event: SessionStartEvent, ctx: ExtensionContext): void {
	if (event.reason !== "fork" || !event.previousSessionFile) return;
	if (ctx.sessionManager.isSubagentSession()) return;
	if (loadGoal(ctx)) return;

	const previousGoalJson = ctx.sessionManager.getSessionGoalJsonForSession(event.previousSessionFile);
	const previousGoal = previousGoalJson ? parseGoalJson(previousGoalJson) : loadLegacyPreviousGoal(event, ctx);
	if (previousGoal && !previousGoal.completedAt) {
		saveGoal(ctx, previousGoal);
	}
}

function loadLegacyPreviousGoal(event: SessionStartEvent, ctx: ExtensionContext): Goal | null {
	if (!event.previousSessionFile) return null;
	const previousSessionId = sessionIdFromSessionFile(event.previousSessionFile);
	return previousSessionId ? loadGoalFile(goalPathForSessionId(ctx.cwd, previousSessionId)) : null;
}

/** The block injected into the system prompt each turn while a goal is active. */
type GoalAssistantMessage = Extract<AgentEndEvent["messages"][number], { role: "assistant" }>;

function findLastAssistantMessage(event: AgentEndEvent): GoalAssistantMessage | undefined {
	return event.messages.filter((message): message is GoalAssistantMessage => message.role === "assistant").at(-1);
}

function didLastAssistantAbort(event: AgentEndEvent): boolean {
	return findLastAssistantMessage(event)?.stopReason === "aborted";
}

function didLastAssistantReturnEmpty(event: AgentEndEvent): boolean {
	const lastAssistantMessage = findLastAssistantMessage(event);
	if (!lastAssistantMessage || lastAssistantMessage.stopReason === "aborted") return false;

	const text = lastAssistantMessage.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	const hasToolCall = lastAssistantMessage.content.some((part) => part.type === "toolCall");
	return text.length === 0 && !hasToolCall;
}

function goalSystemBlock(goal: Goal): string {
	return [
		"<goal>",
		`Long-running objective: ${goal.objective}`,
		`(set on ${goal.branch} at ${goal.createdAt})`,
		...goalStateLines(goal),
		"",
		"Keep working toward this objective across turns until it is achieved.",
		"When it is achieved, call the goal_complete tool.",
		"Do not call set_goal for this objective; it is already active.",
		"If you cannot make further progress, say what is blocking it rather than stopping silently.",
		"</goal>",
	].join("\n");
}

function setGoal(params: SetGoalParams): { ok: boolean; message: string; severity: "error" | "info" | "warning"; goal?: Goal } {
	const { objective, ctx, pi } = params;
	if (objective.length > MAX_OBJECTIVE_CHARS) {
		return {
			ok: false,
			message: `Objective too long (${objective.length} > ${MAX_OBJECTIVE_CHARS} chars)`,
			severity: "error",
		};
	}

	const goal: Goal = {
		objective,
		branch: currentBranch(ctx.cwd),
		createdAt: new Date().toISOString(),
		continuationTurns: 0,
	};
	saveGoal(ctx, goal);
	updateGoalFooterStatus(ctx);

	const idle = ctx.isIdle();
	if (idle) {
		pi.sendUserMessage(`Work toward this objective until it is achieved: ${objective}`);
	}

	return {
		ok: true,
		message: idle ? "Goal set — starting work" : "Goal saved — it will guide the current run",
		severity: "info",
		goal,
	};
}

export default function goalExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "set_goal",
		label: "Set Goal",
		description: "Set the active long-running /goal objective.",
		promptGuidelines: [],
		approvalRequired: false,
		parameters: Type.Object({
			objective: Type.String(),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const objective = params.objective.trim();
			if (!objective) {
				return {
					content: [{ type: "text", text: "Objective is required." }],
					details: {},
				};
			}

			const result = setGoal({
				objective,
				ctx,
				pi,
			});
			ctx.ui.notify(result.message, result.severity);

			return {
				content: [
					{
						type: "text",
						text: result.ok ? `Goal set: ${objective}` : result.message,
					},
				],
				details: result.goal ? { objective: result.goal.objective } : {},
			};
		},
	});

	pi.registerTool({
		name: "goal_complete",
		label: "Goal Complete",
		description: "Mark the active long-running /goal objective as complete.",
		approvalRequired: false,
		parameters: Type.Object({
			reason: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const reason = params.reason?.trim() || "complete";
			const goal = markGoalComplete(ctx, reason);
			if (!goal) {
				return {
					content: [{ type: "text", text: "No active goal to complete." }],
					details: {},
				};
			}
			updateGoalFooterStatus(ctx);
			ctx.ui.notify(`Goal complete: ${goal.objective}`, "info");
			return {
				content: [{ type: "text", text: `Goal marked complete: ${reason}` }],
				details: {},
			};
		},
	});

	// Notify on session start if an objective is active.
	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		inheritPreviousSessionGoal(event, ctx);
		const goal = loadActiveGoal(ctx);
		updateGoalFooterStatus(ctx);
		if (goal) ctx.ui.notify(goalStartupMessage(goal), "info");
	});

	pi.on("agent_end", async (event, ctx: ExtensionContext) => {
		const goal = loadRunningGoal(ctx);
		if (!goal) return;

		if (didLastAssistantAbort(event)) {
			pauseGoal(ctx);
			updateGoalFooterStatus(ctx);
			return;
		}

		if (ctx.hasPendingMessages()) return;

		if (didLastAssistantReturnEmpty(event)) {
			ctx.ui.notify("Goal continuation stopped because the last assistant response was empty", "warning");
			return;
		}

		const continuationTurns = goal.continuationTurns ?? 0;
		saveGoal(ctx, { ...goal, continuationTurns: continuationTurns + 1 });
		pi.sendUserMessage(`Continue working toward this objective until it is achieved: ${goal.objective}`, {
			deliverAs: "followUp",
		});
	});

	// Inject the active objective into the system prompt every turn.
	pi.on("before_agent_start", async (event, ctx) => {
		const goal = loadRunningGoal(ctx);
		if (!goal) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemBlock(goal)}` };
	});

	pi.registerCommand("goal", {
		description: "Set, view, pause, or clear the objective for a long-running task (/goal <objective> | /goal | /goal pause | /goal clear)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsedArgs = parseGoalArgs(args);
			if ("error" in parsedArgs) {
				ctx.ui.notify(parsedArgs.error, "error");
				return;
			}
			const { objective } = parsedArgs;

			// View
			if (!objective) {
				const goal = loadActiveGoal(ctx);
				ctx.ui.notify(goal ? goalViewMessage(goal) : "No active goal — use /goal <objective>", "info");
				return;
			}

			// Pause
			if (objective === "pause") {
				const goal = pauseGoal(ctx);
				ctx.ui.notify(goal ? `Goal paused: ${goal.objective}` : "No active goal to pause", "info");
				updateGoalFooterStatus(ctx);
				return;
			}

			// Clear
			if (objective === "clear") {
				ctx.ui.notify(clearGoal(ctx) ? "Goal cleared" : "No active goal", "info");
				updateGoalFooterStatus(ctx);
				return;
			}

			const result = setGoal({ objective, ctx, pi });
			ctx.ui.notify(result.message, result.severity);
		},
	});
}
