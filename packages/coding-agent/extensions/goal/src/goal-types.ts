import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorResponse } from "../../../src/core/session-control-db.ts";

export interface Goal {
	objective: string;
	branch: string;
	createdAt: string;
	completedAt?: string;
	completionReason?: string;
	continuationTurns?: number;
	pausedAt?: string;
}

export type GoalSupervisorResponse = Extract<
	SupervisorResponse,
	{ kind: "complete" | "continue" | "pause" | "wait" | "error" }
>;

export type GoalSupervisorReview = (input: {
	kind: "goal_completion_review" | "goal_idle_review";
	payload: Record<string, unknown>;
	ctx: ExtensionContext;
}) => Promise<GoalSupervisorResponse>;

export interface GoalExtensionOptions {
	reviewGoal?: GoalSupervisorReview;
}
