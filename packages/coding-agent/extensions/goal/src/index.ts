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
 *   /goal resume                  resume a paused objective
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
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAgentDir } from "../../../src/config.ts";
import { getControlDbPath, type SupervisorResponse } from "../../../src/core/session-control-db.ts";
import { requestSupervisorDecision } from "../../../src/supervisor/client.ts";
import {
	DEFAULT_SUPERVISOR_KB_DIR,
	resolveSupervisorProjectForCwd,
} from "../../../src/supervisor/project-resolver.ts";

/** codex caps the objective at 4000 characters. */
const MAX_OBJECTIVE_CHARS = 4000;
const GOAL_REVIEW_TIMEOUT_MS = 180_000;
const RESERVED_GOAL_OBJECTIVES = new Set(["set", "pause", "resume", "clear", "status", "complete", "continue"]);

interface Goal {
	objective: string;
	branch: string;
	createdAt: string;
	completedAt?: string;
	completionReason?: string;
	continuationTurns?: number;
	pausedAt?: string;
}

type ParsedGoalArgs =
	| { action: "view" | "pause" | "resume" | "clear" }
	| { action: "set"; objective: string };

interface SetGoalParams {
	objective: string;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
}

type ManageGoalAction = "set" | "pause" | "resume" | "complete" | "clear" | "status";

interface ManageGoalParams {
	action: ManageGoalAction;
	objective?: string;
	reason?: string;
}

interface ManageGoalContext {
	ctx: ExtensionContext;
	params: ManageGoalParams;
	pi: ExtensionAPI;
	reviewGoal: GoalSupervisorReview;
}

export type GoalSupervisorResponse = Extract<
	SupervisorResponse,
	{ kind: "complete" | "continue" | "pause" | "error" }
>;

export type GoalSupervisorReview = (input: {
	kind: "goal_completion_review" | "goal_idle_review";
	payload: Record<string, unknown>;
	ctx: ExtensionContext;
}) => Promise<GoalSupervisorResponse>;

export interface GoalExtensionOptions {
	reviewGoal?: GoalSupervisorReview;
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
	const goal = loadActiveGoal(ctx);
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

function resumeGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const goal = loadActiveGoal(ctx);
	if (!goal?.pausedAt) return null;
	const { pausedAt: _pausedAt, ...resumedGoal } = goal;
	saveGoal(ctx, resumedGoal);
	return resumedGoal;
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
	}
	if (parts.length === 0) return { action: "view" };
	const [action, ...objectiveParts] = parts;
	if (action === "set") {
		const objective = objectiveParts.join(" ");
		return objective ? { action: "set", objective } : { error: "Use /goal set <objective> to set a goal" };
	}
	if ((action === "pause" || action === "resume" || action === "clear") && objectiveParts.length === 0) {
		return { action };
	}
	return { error: "Use /goal set <objective> to set a goal" };
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
		'When it is achieved, call the manage_goal tool with action "complete".',
		"Do not call manage_goal with action set for this objective; it is already active.",
		"If you cannot make further progress, say what is blocking it rather than stopping silently.",
		"</goal>",
	].join("\n");
}

function textResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function setGoal(params: SetGoalParams): { ok: boolean; message: string; severity: "error" | "info" | "warning"; goal?: Goal } {
	const { objective, ctx, pi } = params;
	if (RESERVED_GOAL_OBJECTIVES.has(objective.toLowerCase())) {
		return {
			ok: false,
			message: `Objective cannot be a goal control command: ${objective}`,
			severity: "error",
		};
	}
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
		pi.sendUserMessage("Continue working toward the active goal.");
	}

	return {
		ok: true,
		message: idle ? "Goal set — starting work" : "Goal saved — it will guide the current run",
		severity: "info",
		goal,
	};
}

function runSetGoalAction({ ctx, params, pi }: Omit<ManageGoalContext, "reviewGoal">): AgentToolResult<unknown> {
	const objective = params.objective?.trim() ?? "";
	if (!objective) {
		return textResult("Objective is required.");
	}

	const result = setGoal({ objective, ctx, pi });
	ctx.ui.notify(result.message, result.severity);
	const details = result.goal ? { objective: result.goal.objective } : {};
	return textResult(result.ok ? `Goal set: ${objective}` : result.message, details);
}

function runPauseGoalAction(ctx: ExtensionContext): AgentToolResult<unknown> {
	const goal = pauseGoal(ctx);
	updateGoalFooterStatus(ctx);
	if (!goal) {
		ctx.ui.notify("No active goal to pause", "info");
		return textResult("No active goal to pause.");
	}

	ctx.ui.notify(`Goal paused: ${goal.objective}`, "info");
	return textResult(`Goal paused: ${goal.objective}`, { objective: goal.objective });
}

function runResumeGoalAction(ctx: ExtensionContext, pi: ExtensionAPI): AgentToolResult<unknown> {
	const goal = resumeGoal(ctx);
	updateGoalFooterStatus(ctx);
	if (!goal) {
		ctx.ui.notify("No paused goal to resume", "info");
		return textResult("No paused goal to resume.");
	}

	ctx.ui.notify(`Goal resumed: ${goal.objective}`, "info");
	if (ctx.isIdle()) {
		pi.sendUserMessage("Continue working toward the active goal.");
	}
	return textResult(`Goal resumed: ${goal.objective}`, { objective: goal.objective });
}

function pauseGoalFromSupervisor(ctx: ExtensionContext, reason: string): boolean {
	const goal = pauseGoal(ctx);
	if (!goal) return false;
	updateGoalFooterStatus(ctx);
	ctx.ui.notify(`Goal paused: ${reason}`, "info");
	return true;
}

async function runCompleteGoalAction(
	ctx: ExtensionContext,
	reasonInput: string | undefined,
	reviewGoal: GoalSupervisorReview,
	pi: ExtensionAPI,
): Promise<AgentToolResult<unknown>> {
	const activeGoal = loadActiveGoal(ctx);
	if (!activeGoal) return textResult("No active goal to complete.");

	const reason = reasonInput?.trim() || "complete";
	const decision = await reviewGoal({
		ctx,
		kind: "goal_completion_review",
		payload: { objective: activeGoal.objective, proposedCompletionReason: reason },
	});
	if (decision.kind === "continue") {
		pi.sendUserMessage(decision.instructions, { deliverAs: "followUp" });
		return textResult(`Goal remains active: ${decision.reason}`, { instructions: decision.instructions });
	}
	if (decision.kind === "pause") {
		pauseGoalFromSupervisor(ctx, decision.reason);
		return textResult(`Goal paused: ${decision.reason}`);
	}
	if (decision.kind !== "complete") {
		ctx.ui.notify(`Supervisor goal review failed: ${decision.reason}`, "error");
		return textResult(`Goal review failed: ${decision.reason}`);
	}

	const goal = markGoalComplete(ctx, reason);
	if (!goal) return textResult("No active goal to complete.");
	updateGoalFooterStatus(ctx);
	ctx.ui.notify(`Goal complete: ${goal.objective}`, "info");
	return textResult(`Goal marked complete: ${reason}`);
}

function runClearGoalAction(ctx: ExtensionContext): AgentToolResult<unknown> {
	const cleared = clearGoal(ctx);
	updateGoalFooterStatus(ctx);
	const message = cleared ? "Goal cleared" : "No active goal";
	ctx.ui.notify(message, "info");
	return textResult(message);
}

function runGoalStatusAction(ctx: ExtensionContext): AgentToolResult<unknown> {
	const goal = loadActiveGoal(ctx);
	const message = goal ? goalViewMessage(goal) : "No active goal — use /goal set <objective>";
	ctx.ui.notify(message, "info");
	const details = goal ? { objective: goal.objective } : {};
	return textResult(message, details);
}

async function manageGoal({ ctx, params, pi, reviewGoal }: ManageGoalContext): Promise<AgentToolResult<unknown>> {
	switch (params.action) {
		case "set":
			return runSetGoalAction({ ctx, params, pi });
		case "pause":
			return runPauseGoalAction(ctx);
		case "resume":
			return runResumeGoalAction(ctx, pi);
		case "complete":
			return runCompleteGoalAction(ctx, params.reason, reviewGoal, pi);
		case "clear":
			return runClearGoalAction(ctx);
		case "status":
			return runGoalStatusAction(ctx);
	}
}

async function reviewGoalWithResidentSupervisor(input: {
	kind: "goal_completion_review" | "goal_idle_review";
	payload: Record<string, unknown>;
	ctx: ExtensionContext;
}): Promise<GoalSupervisorResponse> {
	const kbDir = process.env.PI_KB_DIR ?? DEFAULT_SUPERVISOR_KB_DIR;
	const response = await requestSupervisorDecision({
		controlDbPath: getControlDbPath(getAgentDir()),
		kind: input.kind,
		payload: input.payload,
		projectId: resolveSupervisorProjectForCwd(input.ctx.cwd, kbDir),
		senderSessionId: input.ctx.sessionManager.getSessionId(),
		timeoutMs: GOAL_REVIEW_TIMEOUT_MS,
	});
	switch (response.kind) {
		case "complete":
		case "continue":
		case "pause":
		case "error":
			return response;
		default:
			return { kind: "error", reason: `Invalid goal review response: ${response.kind}` };
	}
}

export default function goalExtension(pi: ExtensionAPI, options: GoalExtensionOptions = {}) {
	const reviewGoal = options.reviewGoal ?? reviewGoalWithResidentSupervisor;
	pi.registerTool({
		name: "manage_goal",
		label: "Manage Goal",
		description: "Manage the active long-running /goal objective.",
		promptGuidelines: [],
		approvalRequired: false,
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("set"),
				Type.Literal("pause"),
				Type.Literal("resume"),
				Type.Literal("complete"),
				Type.Literal("clear"),
				Type.Literal("status"),
			]),
			objective: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => manageGoal({ ctx, params, pi, reviewGoal }),
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

		if (ctx.hasPendingMessages()) return;

		if (didLastAssistantAbort(event)) {
			pauseGoal(ctx);
			updateGoalFooterStatus(ctx);
			return;
		}

		if (findLastAssistantMessage(event)?.stopReason === "error") return;

		if (didLastAssistantReturnEmpty(event)) {
			ctx.ui.notify("Goal continuation stopped because the last assistant response was empty", "warning");
			return;
		}

		const decision = await reviewGoal({
			ctx,
			kind: "goal_idle_review",
			payload: {
				objective: goal.objective,
				terminalTurn: event.messages,
			},
		});
		if (ctx.hasPendingMessages()) return;

		if (decision.kind === "complete") {
			markGoalComplete(ctx, decision.reason);
			updateGoalFooterStatus(ctx);
			ctx.ui.notify(`Goal complete: ${goal.objective}`, "info");
			return;
		}
		if (decision.kind === "pause") {
			pauseGoalFromSupervisor(ctx, decision.reason);
			return;
		}
		if (decision.kind === "error") {
			ctx.ui.notify(`Supervisor goal review failed: ${decision.reason}`, "error");
			return;
		}
		if (decision.kind !== "continue") {
			ctx.ui.notify("Supervisor returned an invalid goal response", "error");
			return;
		}
		const continuationTurns = goal.continuationTurns ?? 0;
		saveGoal(ctx, { ...goal, continuationTurns: continuationTurns + 1 });
		pi.sendUserMessage(decision.instructions, { deliverAs: "followUp" });
	});

	// Inject the active objective into the system prompt every turn.
	pi.on("before_agent_start", async (event, ctx) => {
		const goal = loadRunningGoal(ctx);
		if (!goal) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemBlock(goal)}` };
	});

	pi.registerCommand("goal", {
		description: "Set, view, pause, resume, or clear the objective for a long-running task (/goal set <objective> | /goal | /goal pause | /goal resume | /goal clear)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsedArgs = parseGoalArgs(args);
			if ("error" in parsedArgs) {
				ctx.ui.notify(parsedArgs.error, "error");
				return;
			}
			if (parsedArgs.action === "view") {
				const goal = loadActiveGoal(ctx);
				ctx.ui.notify(goal ? goalViewMessage(goal) : "No active goal — use /goal set <objective>", "info");
				return;
			}
			if (parsedArgs.action === "pause") {
				const goal = pauseGoal(ctx);
				ctx.ui.notify(goal ? `Goal paused: ${goal.objective}` : "No active goal to pause", "info");
				updateGoalFooterStatus(ctx);
				return;
			}
			if (parsedArgs.action === "resume") {
				const goal = resumeGoal(ctx);
				ctx.ui.notify(goal ? `Goal resumed: ${goal.objective}` : "No paused goal to resume", "info");
				updateGoalFooterStatus(ctx);
				if (goal && ctx.isIdle()) pi.sendUserMessage("Continue working toward the active goal.");
				return;
			}
			if (parsedArgs.action === "clear") {
				ctx.ui.notify(clearGoal(ctx) ? "Goal cleared" : "No active goal", "info");
				updateGoalFooterStatus(ctx);
				return;
			}
			if (parsedArgs.action !== "set") return;
			const result = setGoal({ objective: parsedArgs.objective, ctx, pi });
			ctx.ui.notify(result.message, result.severity);
		},
	});
}
