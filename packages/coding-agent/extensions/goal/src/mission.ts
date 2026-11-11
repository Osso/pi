import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
import { readSessionHistoryReverse } from "../../../src/core/session-history.ts";
import type { Goal } from "./goal-types.ts";

const MISSION_ENTRY_TYPE = "mission";
const MISSION_PAUSE_REASON = "Mission paused by user.";

export const MISSION_GOAL_COMPLETION_REJECTED = "Mission goals are continuous; only the user stops a mission.";

/** Starts a Supervisor idle review of a goal once the session is idle; the idle goal scheduler implements it. */
export interface MissionGoalReviewer {
	deferReview(goal: Goal, ctx: ExtensionContext, terminalTurn: AgentEndEvent["messages"]): void;
}

interface Mission {
	objective: string;
	pausedAt?: string;
}

type GoalContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

interface SessionMissionState {
	sessionId: string;
	hydrated: boolean;
	version: number;
	mission: Mission | null;
}

const missionStateByManager = new WeakMap<GoalContext["sessionManager"], SessionMissionState>();

function parseMission(data: unknown): Mission | null {
	if (!isRecord(data)) return null;
	const objective = optionalString(data.objective)?.trim();
	return objective ? { objective, pausedAt: optionalString(data.pausedAt) } : null;
}

/** The newest mission entry wins; an entry without an objective records a cleared mission. */
function loadMission(ctx: GoalContext): Mission | null {
	const state = missionState(ctx);
	return state.hydrated ? state.mission : null;
}

function missionState(ctx: GoalContext): SessionMissionState {
	const sessionManager = ctx.sessionManager;
	const sessionId = sessionManager.getSessionId();
	let state = missionStateByManager.get(sessionManager);
	if (!state || state.sessionId !== sessionId) {
		state = { sessionId, hydrated: false, version: 0, mission: null };
		missionStateByManager.set(sessionManager, state);
	}
	return state;
}

async function hydrateMission(ctx: GoalContext): Promise<void> {
	const state = missionState(ctx);
	if (state.hydrated) return;
	const version = state.version;
	let mission: Mission | null = null;
	for await (const entry of readSessionHistoryReverse(ctx.sessionManager)) {
		if (entry.type === "custom" && entry.customType === MISSION_ENTRY_TYPE) {
			mission = parseMission(entry.data);
			break;
		}
	}
	if (state.version === version) {
		state.mission = mission;
		state.hydrated = true;
	}
}

function appendMission(mission: Mission | null, ctx: GoalContext, pi: ExtensionAPI): void {
	const state = missionState(ctx);
	pi.appendEntry(MISSION_ENTRY_TYPE, mission ?? {});
	state.version++;
	state.mission = mission;
	state.hydrated = true;
}

export async function restoreMissionToGoal(ctx: GoalContext): Promise<void> {
	await hydrateMission(ctx);
	copyMissionToGoal(ctx);
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

/**
 * Copies the mission into the working goal after that goal stops running; `reviewer` starts work on
 * the copy. A caller inside a run passes none, because that run's agent_end review continues it.
 */
export function continueMission(ctx: ExtensionContext, reviewer?: MissionGoalReviewer): void {
	const goal = copyMissionToGoal(ctx);
	updateGoalFooterStatus(ctx);
	if (goal) reviewer?.deferReview(goal, ctx, []);
}

/** Continues the mission from a command or timer: only an idle session needs the review, a run has its own. */
export function continueMissionWhenIdle(ctx: ExtensionContext, reviewer: MissionGoalReviewer): void {
	continueMission(ctx, ctx.isIdle() ? reviewer : undefined);
}

function setMission(
	objective: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	reviewer: MissionGoalReviewer,
): void {
	appendMission({ objective }, ctx, pi);
	if (loadOrMigrateActiveGoal(ctx)?.mission) clearGoal(ctx);
	ctx.ui.notify(`Mission set: ${objective}`, "info");
	continueMissionWhenIdle(ctx, reviewer);
}

function pauseMission(mission: Mission, ctx: ExtensionCommandContext, pi: ExtensionAPI): void {
	appendMission({ objective: mission.objective, pausedAt: new Date().toISOString() }, ctx, pi);
	if (loadOrMigrateActiveGoal(ctx)?.mission) pauseGoal(ctx, MISSION_PAUSE_REASON);
	ctx.ui.notify(`Mission paused: ${mission.objective}`, "info");
	updateGoalFooterStatus(ctx);
}

function resumeMission(
	mission: Mission,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	reviewer: MissionGoalReviewer,
): void {
	appendMission({ objective: mission.objective }, ctx, pi);
	ctx.ui.notify(`Mission resumed: ${mission.objective}`, "info");
	continueMissionWhenIdle(ctx, reviewer);
}

function clearMission(ctx: ExtensionCommandContext, pi: ExtensionAPI): void {
	appendMission(null, ctx, pi);
	if (loadOrMigrateActiveGoal(ctx)?.mission) clearGoal(ctx);
	ctx.ui.notify("Mission cleared", "info");
	updateGoalFooterStatus(ctx);
}

function showMission(mission: Mission | null, ctx: ExtensionCommandContext): void {
	if (!mission) return ctx.ui.notify("No mission — use /mission set <objective>", "info");
	ctx.ui.notify(mission.pausedAt ? `Mission paused: ${mission.objective}` : `Mission: ${mission.objective}`, "info");
}

function handleMissionCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	reviewer: MissionGoalReviewer,
): void {
	const [action = "", ...rest] = args.trim().split(/\s+/);
	const mission = loadMission(ctx);
	const objective = rest.join(" ");
	if (action === "set" && objective) return setMission(objective, ctx, pi, reviewer);
	if (rest.length > 0) return ctx.ui.notify("Use /mission set <objective> to set a mission", "error");
	if (action === "") return showMission(mission, ctx);
	if (action === "clear") return mission ? clearMission(ctx, pi) : ctx.ui.notify("No mission", "info");
	if (action === "pause" && mission && !mission.pausedAt) return pauseMission(mission, ctx, pi);
	if (action === "resume" && mission?.pausedAt) return resumeMission(mission, ctx, pi, reviewer);
	if (action === "pause") return ctx.ui.notify("No running mission to pause", "info");
	if (action === "resume") return ctx.ui.notify("No paused mission to resume", "info");
	ctx.ui.notify("Use /mission set <objective> to set a mission", "error");
}

export function registerMissionCommand(
	pi: ExtensionAPI,
	clearGoalSchedules: (sessionId: string) => void,
	reviewer: MissionGoalReviewer,
): void {
	pi.registerCommand("mission", {
		description:
			"Set, view, pause, resume, or clear the user-owned continuous mission (/mission set <objective> | /mission | /mission pause | /mission resume | /mission clear)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim()) clearGoalSchedules(ctx.sessionManager.getSessionId());
			handleMissionCommand(args, ctx, pi, reviewer);
		},
	});
}
