import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorResponse } from "../../../src/core/session-control-db.ts";

export type GoalReviewEvidenceEvent =
	| { kind: "user"; text: string }
	| { kind: "end_turn"; reason: string };

export interface Goal {
	objective: string;
	branch: string;
	createdAt: string;
	completedAt?: string;
	completionReason?: string;
	continuationTurns?: number;
	pausedAt?: string;
	pauseReason?: string;
	reviewEvidence?: GoalReviewEvidenceEvent[];
}

export type GoalSupervisorResponse = Extract<
	SupervisorResponse,
	{ kind: "complete" | "continue" | "pause" | "wait" | "set" | "error" }
>;

export interface GoalReviewInput {
	kind: "goal_completion_review" | "goal_idle_review" | "goal_set_review";
	payload: Record<string, unknown>;
	ctx: ExtensionContext;
}

export type GoalSupervisorReview = (input: GoalReviewInput) => Promise<GoalSupervisorResponse>;

export interface ReviewedGoalResponse {
	decision: GoalSupervisorResponse;
	evidenceCount: number;
}

export type GoalEvidenceReview = (input: GoalReviewInput) => Promise<ReviewedGoalResponse>;

export interface GoalExtensionOptions {
	reviewGoal?: GoalSupervisorReview;
}
