import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseGoal, parseGoalJson } from "./goal-parsing.ts";
import type { Goal } from "./goal-types.ts";

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

function loadGoalFile(file: string): Goal | null {
	if (!fs.existsSync(file)) return null;
	try {
		return parseGoal(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

export function loadOrMigrateGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const storedGoal = ctx.sessionManager.getSessionGoalJson();
	if (storedGoal) return parseGoalJson(storedGoal);
	return migrateLegacyGoal(ctx);
}

export function loadOrMigrateActiveGoal(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): Goal | null {
	const goal = loadOrMigrateGoal(ctx);
	return goal && !goal.completedAt ? goal : null;
}

export function loadOrMigrateRunningGoal(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): Goal | null {
	const goal = loadOrMigrateActiveGoal(ctx);
	return goal && !goal.pausedAt ? goal : null;
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

export function saveGoal(ctx: Pick<ExtensionContext, "sessionManager">, goal: Goal): void {
	saveGoalJson(ctx, goal);
}

export function markGoalComplete(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	reason: string,
): Goal | null {
	const goal = loadOrMigrateActiveGoal(ctx);
	if (!goal) return null;
	const completedGoal: Goal = {
		...goal,
		completedAt: new Date().toISOString(),
		completionReason: reason,
		reviewEvidence: undefined,
	};
	saveGoal(ctx, completedGoal);
	return completedGoal;
}

export function pauseGoal(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	reason: string,
): Goal | null {
	const goal = loadOrMigrateActiveGoal(ctx);
	if (!goal) return null;
	const pausedGoal: Goal = {
		...goal,
		pausedAt: goal.pausedAt ?? new Date().toISOString(),
		pauseReason: reason,
	};
	saveGoal(ctx, pausedGoal);
	return pausedGoal;
}

export function resumeGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): Goal | null {
	const goal = loadOrMigrateActiveGoal(ctx);
	if (!goal?.pausedAt) return null;
	const { pausedAt: _pausedAt, pauseReason: _pauseReason, ...resumedGoal } = goal;
	saveGoal(ctx, resumedGoal);
	return resumedGoal;
}

export function clearGoal(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): boolean {
	const hasStoredGoal = ctx.sessionManager.getSessionGoalJson() !== undefined;
	const legacyFile = goalPath(ctx);
	const hasLegacyGoal = fs.existsSync(legacyFile);
	ctx.sessionManager.clearSessionGoalJson();
	if (hasLegacyGoal) fs.rmSync(legacyFile);
	return hasStoredGoal || hasLegacyGoal;
}

export function loadPreviousGoalFile(cwd: string, sessionId: string): Goal | null {
	return loadGoalFile(goalPathForSessionId(cwd, sessionId));
}
