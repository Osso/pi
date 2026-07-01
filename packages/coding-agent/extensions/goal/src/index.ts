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
 *   /goal --replace <objective>   replace the active objective
 *   /goal                         view the active objective
 *   /goal clear                   clear the active objective
 *
 * See docs/specs/goal-system.md for the contract.
 *
 * Continuation and budget bounds are implemented below; remaining delivery
 * work is tracked in docs/specs/goal-system.md.
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
const DEFAULT_TOKEN_BUDGET = 1_000_000_000;

interface Goal {
	objective: string;
	branch: string;
	createdAt: string;
	completedAt?: string;
	completionReason?: string;
	continuationTurns?: number;
	tokenBudget?: number;
	wallClockBudgetMs?: number;
}

interface ParsedGoalArgs {
	objective: string;
	replace: boolean;
	tokenBudget?: number;
	wallClockBudgetMs?: number;
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
		tokenBudget: optionalNumber(value.tokenBudget),
		wallClockBudgetMs: optionalNumber(value.wallClockBudgetMs),
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
	return `goal: ${goal.objective}`;
}

function updateGoalFooterStatus(ctx: ExtensionContext): void {
	const goal = loadActiveGoal(ctx);
	ctx.ui.setStatus("goal", goal ? goalFooterStatus(goal) : undefined);
}

function parsePositiveInteger(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseGoalArgs(args: string): ParsedGoalArgs | { error: string } {
	const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
	let tokenBudget: number | undefined;
	let wallClockBudgetMs: number | undefined;
	let replace = false;
	const objectiveParts: string[] = [];

	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (part === "--replace") {
			replace = true;
			continue;
		}
		if (part === "--token-budget") {
			const parsed = parsePositiveInteger(parts[++index]);
			if (parsed === null) return { error: "--token-budget requires a positive integer" };
			tokenBudget = parsed;
			continue;
		}
		if (part === "--wall-clock-minutes") {
			const parsed = parsePositiveInteger(parts[++index]);
			if (parsed === null) return { error: "--wall-clock-minutes requires a positive integer" };
			wallClockBudgetMs = parsed * 60 * 1000;
			continue;
		}
		objectiveParts.push(part);
	}

	return { objective: objectiveParts.join(" "), replace, tokenBudget, wallClockBudgetMs };
}

function wallClockBudgetMinutes(goal: Goal): number {
	return Math.max(1, Math.round((goal.wallClockBudgetMs ?? 0) / (60 * 1000)));
}

function budgetStopReason(goal: Goal, ctx: ExtensionContext): string | null {
	const contextUsage = ctx.getContextUsage();
	if (goal.tokenBudget !== undefined && contextUsage?.tokens !== null && (contextUsage?.tokens ?? 0) >= goal.tokenBudget) {
		return `token budget (${goal.tokenBudget})`;
	}

	if (goal.wallClockBudgetMs !== undefined) {
		const createdAtMs = Date.parse(goal.createdAt);
		if (!Number.isNaN(createdAtMs) && Date.now() - createdAtMs >= goal.wallClockBudgetMs) {
			return `wall-clock budget (${wallClockBudgetMinutes(goal)}m)`;
		}
	}

	return null;
}

function goalStateLines(goal: Goal): string[] {
	const lines = [`Continuation turns used: ${goal.continuationTurns ?? 0}`];
	if (goal.tokenBudget !== undefined) {
		lines.push(`Token budget: ${goal.tokenBudget} tokens`);
	}
	if (goal.wallClockBudgetMs !== undefined) {
		lines.push(`Wall-clock budget: ${wallClockBudgetMinutes(goal)}m`);
	}
	return lines;
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
function didLastAssistantReturnEmpty(event: AgentEndEvent): boolean {
	const assistantMessages = event.messages.filter((message) => message.role === "assistant");
	const lastAssistantMessage = assistantMessages.at(-1);
	if (!lastAssistantMessage) return false;

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
	const { objective, replace, tokenBudget = DEFAULT_TOKEN_BUDGET, wallClockBudgetMs, ctx, pi } = params;
	if (objective.length > MAX_OBJECTIVE_CHARS) {
		return {
			ok: false,
			message: `Objective too long (${objective.length} > ${MAX_OBJECTIVE_CHARS} chars)`,
			severity: "error",
		};
	}

	const activeGoal = loadActiveGoal(ctx);
	if (activeGoal && !replace) {
		return {
			ok: false,
			message: "Active goal already set — use /goal --replace <objective> to replace it",
			severity: "warning",
		};
	}

	const goal: Goal = {
		objective,
		branch: currentBranch(ctx.cwd),
		createdAt: new Date().toISOString(),
		continuationTurns: 0,
		tokenBudget,
		wallClockBudgetMs,
	};
	saveGoal(ctx, goal);
	updateGoalFooterStatus(ctx);

	if (ctx.isIdle()) {
		pi.sendUserMessage(`Work toward this objective until it is achieved: ${objective}`);
	} else {
		ctx.ui.notify("Agent is busy — goal saved; it will guide the current run.", "warning");
	}

	return {
		ok: true,
		message: replace && activeGoal ? "Goal replaced — starting work" : "Goal set — starting work",
		severity: "info",
		goal,
	};
}

export default function goalExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "set_goal",
		label: "Set Goal",
		description:
			"Set the active long-running /goal objective. Do not set tokenBudget or wallClockMinutes unless the user explicitly requested a budget or deadline.",
		promptGuidelines: [
			"When calling set_goal, omit tokenBudget and wallClockMinutes unless the user explicitly requested a token budget, time limit, or deadline.",
		],
		parameters: Type.Object({
			objective: Type.String(),
			replace: Type.Optional(Type.Boolean()),
			tokenBudget: Type.Optional(
				Type.Number({ description: "Optional token ceiling. Omit unless the user explicitly requested a token budget." }),
			),
			wallClockMinutes: Type.Optional(
				Type.Number({ description: "Optional wall-clock ceiling in minutes. Omit unless the user explicitly requested a time limit or deadline." }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const objective = params.objective.trim();
			if (!objective) {
				return {
					content: [{ type: "text", text: "Objective is required." }],
					details: {},
				};
			}

			const activeGoal = loadActiveGoal(ctx);
			if (activeGoal) {
				const message = "Active goal already set — use /goal --replace <objective> to replace it";
				ctx.ui.notify(message, "warning");
				return {
					content: [{ type: "text", text: message }],
					details: { objective: activeGoal.objective },
				};
			}

			const wallClockBudgetMs = params.wallClockMinutes !== undefined ? params.wallClockMinutes * 60 * 1000 : undefined;
			const result = setGoal({
				objective,
				replace: false,
				tokenBudget: params.tokenBudget,
				wallClockBudgetMs,
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
		if (goal) ctx.ui.notify(`Active goal: ${goal.objective}`, "info");
	});

	pi.on("agent_end", async (event, ctx: ExtensionContext) => {
		const goal = loadActiveGoal(ctx);
		if (!goal || ctx.hasPendingMessages()) return;

		const stopReason = budgetStopReason(goal, ctx);
		if (stopReason) {
			ctx.ui.notify(`Goal continuation stopped at ${stopReason}`, "warning");
			return;
		}

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
		const goal = loadActiveGoal(ctx);
		if (!goal) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemBlock(goal)}` };
	});

	pi.registerCommand("goal", {
		description: "Set or view the objective for a long-running task (/goal <objective> | /goal | /goal clear)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsedArgs = parseGoalArgs(args);
			if ("error" in parsedArgs) {
				ctx.ui.notify(parsedArgs.error, "error");
				return;
			}
			const { objective, replace, tokenBudget, wallClockBudgetMs } = parsedArgs;

			// View
			if (!objective) {
				const goal = loadActiveGoal(ctx);
				ctx.ui.notify(goal ? `Goal: ${goal.objective}` : "No active goal — use /goal <objective>", "info");
				return;
			}

			// Clear
			if (objective === "clear") {
				ctx.ui.notify(clearGoal(ctx) ? "Goal cleared" : "No active goal", "info");
				updateGoalFooterStatus(ctx);
				return;
			}

			const result = setGoal({ objective, replace, tokenBudget, wallClockBudgetMs, ctx, pi });
			ctx.ui.notify(result.message, result.severity);
		},
	});
}
