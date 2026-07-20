import type { Goal } from "./goal-types.ts";

export function goalFooterStatus(goal: Goal): string {
	return goal.pausedAt ? `goal paused: ${goal.objective}` : `goal: ${goal.objective}`;
}

export function goalStartupMessage(goal: Goal): string {
	return goal.pausedAt ? `Paused goal: ${goal.objective}` : `Active goal: ${goal.objective}`;
}

export function goalViewMessage(goal: Goal): string {
	return goal.pausedAt ? `Goal paused: ${goal.objective}` : `Goal: ${goal.objective}`;
}

export function goalSystemBlock(goal: Goal): string {
	return [
		"<goal>",
		`Long-running objective: ${goal.objective}`,
		`(set on ${goal.branch} at ${goal.createdAt})`,
		`Continuation turns used: ${goal.continuationTurns ?? 0}`,
		"",
		"Keep working toward this objective across turns until it is achieved.",
		'When it is achieved, call the manage_goal tool with action "complete".',
		"Do not call manage_goal with action set for this objective; it is already active.",
		"If you cannot make further progress, say what is blocking it rather than stopping silently.",
		"</goal>",
	].join("\n");
}
