import type { Goal } from "./goal-types.ts";

const MISSING_PAUSE_REASON = "No pause reason recorded";

function pauseReason(goal: Goal): string {
	return goal.pauseReason?.trim() || MISSING_PAUSE_REASON;
}

export function goalFooterStatus(goal: Goal): string {
	return goal.pausedAt ? `goal paused: ${pauseReason(goal)}` : `goal: ${goal.objective}`;
}

export function goalStartupMessage(goal: Goal): string {
	return goal.pausedAt ? `Paused goal: ${pauseReason(goal)}` : `Active goal: ${goal.objective}`;
}

export function goalViewMessage(goal: Goal): string {
	return goal.pausedAt ? `Goal paused: ${pauseReason(goal)}` : `Goal: ${goal.objective}`;
}

const COMPLETABLE_GOAL_LINES = [
	"Keep working toward this objective across turns until it is achieved.",
	'When it is achieved, call the manage_goal tool with action "complete".',
];

const MISSION_GOAL_LINES = [
	"This objective is the user's continuous mission. It is never complete; only the user stops it.",
	"Keep choosing and doing the next useful work toward it across turns.",
];

export function goalSystemBlock(goal: Goal): string {
	return [
		"<goal>",
		`Long-running objective: ${goal.objective}`,
		`(set on ${goal.branch} at ${goal.createdAt})`,
		`Continuation turns used: ${goal.continuationTurns ?? 0}`,
		"",
		...(goal.mission ? MISSION_GOAL_LINES : COMPLETABLE_GOAL_LINES),
		"Do not call manage_goal with action set for this objective; it is already active.",
		"If you cannot make further progress, say what is blocking it rather than stopping silently.",
		"</goal>",
	].join("\n");
}
