/**
 * Goal System (`/goal`)
 *
 * Sets or views the objective for a long-running task (modeled on codex's
 * `/goal`). A goal is a persistent objective string — NOT a checklist of gates.
 * Once set, the agent starts working toward it, and the objective is injected
 * into the system prompt every turn so it stays anchored across the run and
 * across resume.
 *
 * State is persisted to an inspectable, hand-editable `.pi/goal.json`.
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
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** codex caps the objective at 4000 characters. */
const MAX_OBJECTIVE_CHARS = 4000;
const MAX_CONTINUATION_TURNS = 8;

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
	cwd: string;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
}

function goalPath(cwd: string): string {
	return path.join(cwd, ".pi", "goal.json");
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

function loadGoal(cwd: string): Goal | null {
	const file = goalPath(cwd);
	if (!fs.existsSync(file)) return null;
	try {
		return parseGoal(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

function loadActiveGoal(cwd: string): Goal | null {
	const goal = loadGoal(cwd);
	return goal && !goal.completedAt ? goal : null;
}

function saveGoal(cwd: string, goal: Goal): void {
	const file = goalPath(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(goal, null, 2)}\n`, "utf8");
}

function markGoalComplete(cwd: string, reason: string): Goal | null {
	const goal = loadGoal(cwd);
	if (!goal) return null;
	const completedGoal: Goal = {
		...goal,
		completedAt: new Date().toISOString(),
		completionReason: reason,
	};
	saveGoal(cwd, completedGoal);
	return completedGoal;
}

function clearGoal(cwd: string): boolean {
	const file = goalPath(cwd);
	if (!fs.existsSync(file)) return false;
	fs.rmSync(file);
	return true;
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
	const lines = [`Continuation turns used: ${goal.continuationTurns ?? 0}/${MAX_CONTINUATION_TURNS}`];
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

/** The block injected into the system prompt each turn while a goal is active. */
function goalSystemBlock(goal: Goal): string {
	return [
		"<goal>",
		`Long-running objective: ${goal.objective}`,
		`(set on ${goal.branch} at ${goal.createdAt})`,
		...goalStateLines(goal),
		"",
		"Keep working toward this objective across turns until it is achieved.",
		"When it is achieved, state clearly that the goal is complete. If you cannot",
		"make further progress, say what is blocking it rather than stopping silently.",
		"</goal>",
	].join("\n");
}

function setGoal(params: SetGoalParams): { ok: boolean; message: string; severity: "error" | "info" | "warning"; goal?: Goal } {
	const { objective, replace, tokenBudget, wallClockBudgetMs, cwd, ctx, pi } = params;
	if (objective.length > MAX_OBJECTIVE_CHARS) {
		return {
			ok: false,
			message: `Objective too long (${objective.length} > ${MAX_OBJECTIVE_CHARS} chars)`,
			severity: "error",
		};
	}

	const activeGoal = loadActiveGoal(cwd);
	if (activeGoal && !replace) {
		return {
			ok: false,
			message: "Active goal already set — use /goal --replace <objective> to replace it",
			severity: "warning",
		};
	}

	const goal: Goal = {
		objective,
		branch: currentBranch(cwd),
		createdAt: new Date().toISOString(),
		continuationTurns: 0,
		tokenBudget,
		wallClockBudgetMs,
	};
	saveGoal(cwd, goal);

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
		description: "Set the active long-running /goal objective.",
		parameters: Type.Object({
			objective: Type.String(),
			replace: Type.Optional(Type.Boolean()),
			tokenBudget: Type.Optional(Type.Number()),
			wallClockMinutes: Type.Optional(Type.Number()),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const objective = params.objective.trim();
			if (!objective) {
				return {
					content: [{ type: "text", text: "Objective is required." }],
					details: {},
				};
			}

			const wallClockBudgetMs =
				params.wallClockMinutes !== undefined ? params.wallClockMinutes * 60 * 1000 : undefined;
			const result = setGoal({
				objective,
				replace: params.replace ?? false,
				tokenBudget: params.tokenBudget,
				wallClockBudgetMs,
				cwd: ctx.cwd,
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
			const goal = markGoalComplete(ctx.cwd, reason);
			if (!goal) {
				return {
					content: [{ type: "text", text: "No active goal to complete." }],
					details: {},
				};
			}
			ctx.ui.notify(`Goal complete: ${goal.objective}`, "info");
			return {
				content: [{ type: "text", text: `Goal marked complete: ${reason}` }],
				details: {},
			};
		},
	});

	// Notify on session start if an objective is active.
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const goal = loadActiveGoal(ctx.cwd);
		if (goal) ctx.ui.notify(`Active goal: ${goal.objective}`, "info");
	});

	pi.on("agent_end", async (_event, ctx: ExtensionContext) => {
		const goal = loadActiveGoal(ctx.cwd);
		if (!goal || !ctx.isIdle() || ctx.hasPendingMessages()) return;

		const stopReason = budgetStopReason(goal, ctx);
		if (stopReason) {
			ctx.ui.notify(`Goal continuation stopped at ${stopReason}`, "warning");
			return;
		}

		const continuationTurns = goal.continuationTurns ?? 0;
		if (continuationTurns >= MAX_CONTINUATION_TURNS) {
			ctx.ui.notify(`Goal continuation stopped at turn cap (${MAX_CONTINUATION_TURNS})`, "warning");
			return;
		}

		saveGoal(ctx.cwd, { ...goal, continuationTurns: continuationTurns + 1 });
		pi.sendUserMessage(`Continue working toward this objective until it is achieved: ${goal.objective}`);
	});

	// Inject the active objective into the system prompt every turn.
	pi.on("before_agent_start", async (event, ctx) => {
		const goal = loadActiveGoal(ctx.cwd);
		if (!goal) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemBlock(goal)}` };
	});

	pi.registerCommand("goal", {
		description: "Set or view the objective for a long-running task (/goal <objective> | /goal | /goal clear)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cwd = ctx.cwd;
			const parsedArgs = parseGoalArgs(args);
			if ("error" in parsedArgs) {
				ctx.ui.notify(parsedArgs.error, "error");
				return;
			}
			const { objective, replace, tokenBudget, wallClockBudgetMs } = parsedArgs;

			// View
			if (!objective) {
				const goal = loadActiveGoal(cwd);
				ctx.ui.notify(goal ? `Goal: ${goal.objective}` : "No active goal — use /goal <objective>", "info");
				return;
			}

			// Clear
			if (objective === "clear") {
				ctx.ui.notify(clearGoal(cwd) ? "Goal cleared" : "No active goal", "info");
				return;
			}

			const result = setGoal({ objective, replace, tokenBudget, wallClockBudgetMs, cwd, ctx, pi });
			ctx.ui.notify(result.message, result.severity);
		},
	});
}
