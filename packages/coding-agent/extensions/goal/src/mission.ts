import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, optionalString } from "./goal-parsing.ts";
import { goalFooterStatus } from "./goal-presentation.ts";
import {
	clearGoal,
	createGoal,
	loadOrMigrateActiveGoal,
	loadOrMigrateGoal,
	pauseGoal,
	saveGoal,
	USER_PAUSE_REASON,
} from "./goal-state.ts";
import type { Goal } from "./goal-types.ts";

const MISSION_ENTRY_TYPE = "mission";
const MISSION_PAUSE_REASON = "Mission paused by user.";
const GOAL_REMINDER = "Continue working toward the active goal.";

export const MISSION_GOAL_COMPLETION_REJECTED = "Mission goals are continuous; only the user stops a mission.";

interface Mission {
	objective: string;
	pausedAt?: string;
}

type GoalContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

function parseMission(data: unknown): Mission | null {
	if (!isRecord(data)) return null;
	const objective = optionalString(data.objective)?.trim();
	return objective ? { objective, pausedAt: optionalString(data.pausedAt) } : null;
}

/** The newest mission entry wins; an entry without an objective records a cleared mission. */
function loadMission(ctx: Pick<ExtensionContext, "sessionManager">): Mission | null {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === MISSION_ENTRY_TYPE) return parseMission(entry.data);
	}
	return null;
}

export function updateGoalFooterStatus(ctx: ExtensionContext): void {
	const mission = loadMission(ctx);
	ctx.ui.setStatus("mission", mission ? missionFooterStatus(mission) : undefined);
	const goal = loadOrMigrateActiveGoal(ctx);
	ctx.ui.setStatus("goal", goal ? goalFooterStatus(goal) : undefined);
}

function missionFooterStatus(mission: Mission): string {
	return mission.pausedAt ? `mission paused: ${mission.objective}` : `mission: ${mission.objective}`;
}

/** A running goal and a goal paused by the user keep their place; any other goal state yields to the mission. */
function missionReplacesGoal(goal: Goal | null): boolean {
	if (!goal || goal.completedAt) return true;
	return Boolean(goal.pausedAt) && goal.pauseReason !== USER_PAUSE_REASON;
}

export function copyMissionToGoal(ctx: GoalContext): Goal | null {
	const mission = loadMission(ctx);
	if (!mission || mission.pausedAt) return null;
	if (!missionReplacesGoal(loadOrMigrateGoal(ctx))) return null;
	const goal: Goal = { ...createGoal(mission.objective, ctx.cwd), mission: true };
	saveGoal(ctx, goal);
	return goal;
}

/** Restarts work on the mission after the working goal stops running. */
export function continueMission(ctx: ExtensionContext, pi: ExtensionAPI): void {
	const goal = copyMissionToGoal(ctx);
	updateGoalFooterStatus(ctx);
	if (goal) pi.sendUserMessage(GOAL_REMINDER, { deliverAs: "followUp" });
}

function setMission(objective: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): void {
	pi.appendEntry(MISSION_ENTRY_TYPE, { objective });
	if (loadOrMigrateActiveGoal(ctx)?.mission) clearGoal(ctx);
	ctx.ui.notify(`Mission set: ${objective}`, "info");
	continueMission(ctx, pi);
}

function pauseMission(mission: Mission, ctx: ExtensionCommandContext, pi: ExtensionAPI): void {
	pi.appendEntry(MISSION_ENTRY_TYPE, { objective: mission.objective, pausedAt: new Date().toISOString() });
	if (loadOrMigrateActiveGoal(ctx)?.mission) pauseGoal(ctx, MISSION_PAUSE_REASON);
	ctx.ui.notify(`Mission paused: ${mission.objective}`, "info");
	updateGoalFooterStatus(ctx);
}

function resumeMission(mission: Mission, ctx: ExtensionCommandContext, pi: ExtensionAPI): void {
	pi.appendEntry(MISSION_ENTRY_TYPE, { objective: mission.objective });
	ctx.ui.notify(`Mission resumed: ${mission.objective}`, "info");
	continueMission(ctx, pi);
}

function clearMission(ctx: ExtensionCommandContext, pi: ExtensionAPI): void {
	pi.appendEntry(MISSION_ENTRY_TYPE, {});
	if (loadOrMigrateActiveGoal(ctx)?.mission) clearGoal(ctx);
	ctx.ui.notify("Mission cleared", "info");
	updateGoalFooterStatus(ctx);
}

function showMission(mission: Mission | null, ctx: ExtensionCommandContext): void {
	if (!mission) return ctx.ui.notify("No mission — use /mission set <objective>", "info");
	ctx.ui.notify(mission.pausedAt ? `Mission paused: ${mission.objective}` : `Mission: ${mission.objective}`, "info");
}

function handleMissionCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): void {
	const [action = "", ...rest] = args.trim().split(/\s+/);
	const mission = loadMission(ctx);
	const objective = rest.join(" ");
	if (action === "set" && objective) return setMission(objective, ctx, pi);
	if (rest.length > 0) return ctx.ui.notify("Use /mission set <objective> to set a mission", "error");
	if (action === "") return showMission(mission, ctx);
	if (action === "clear") return mission ? clearMission(ctx, pi) : ctx.ui.notify("No mission", "info");
	if (action === "pause" && mission && !mission.pausedAt) return pauseMission(mission, ctx, pi);
	if (action === "resume" && mission?.pausedAt) return resumeMission(mission, ctx, pi);
	if (action === "pause") return ctx.ui.notify("No running mission to pause", "info");
	if (action === "resume") return ctx.ui.notify("No paused mission to resume", "info");
	ctx.ui.notify("Use /mission set <objective> to set a mission", "error");
}

export function registerMissionCommand(pi: ExtensionAPI, clearGoalSchedules: (sessionId: string) => void): void {
	pi.registerCommand("mission", {
		description:
			"Set, view, pause, resume, or clear the user-owned continuous mission (/mission set <objective> | /mission | /mission pause | /mission resume | /mission clear)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim()) clearGoalSchedules(ctx.sessionManager.getSessionId());
			handleMissionCommand(args, ctx, pi);
		},
	});
}
