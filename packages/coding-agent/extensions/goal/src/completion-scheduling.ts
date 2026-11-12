import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalReviewEvidenceController } from "./goal-review-evidence.ts";
import { createGoalScheduler } from "./goal-scheduling.ts";
import { goalMatchesReview, loadOrMigrateActiveGoal, markGoalComplete } from "./goal-state.ts";
import type { Goal, GoalEvidenceReview, ReviewedGoalResponse } from "./goal-types.ts";
import type { GoalWorkStarter } from "./goal-work.ts";
import { continueMission } from "./mission.ts";
import { sendSupervisorInstructions, type SupervisorStatusController } from "./rendering.ts";
import { appendGoalSchedulingError } from "./wait-status.ts";

interface CompletionWait {
	goal: Goal;
	completionReport: string;
}

interface CompletionSchedulingOptions {
	pi: ExtensionAPI;
	reviewGoal: GoalEvidenceReview;
	consumeReviewEvidence: (ctx: ExtensionContext, reviewedGoal: Goal, evidenceCount: number) => void;
	isSameGoal: (ctx: ExtensionContext, waiting: CompletionWait) => boolean;
	onComplete: (waiting: CompletionWait, ctx: ExtensionContext) => void;
	onContinue: (instructions: string, displayId?: string) => void;
	onStatus: (ctx: ExtensionContext, message: string, reviewAt?: string, displayId?: string) => void;
	onClearStatus: (sessionId: string) => void;
	onError: (error: unknown, ctx: ExtensionContext) => void;
}

export interface CompletionWaitScheduler {
	clearAll(): void;
	clearSession(sessionId: string): void;
	createReviewGuard(ctx: ExtensionContext): () => boolean;
	wait(
		goal: Goal,
		ctx: ExtensionContext,
		completionReport: string,
		statusReason: string,
		displayId?: string,
	): Promise<void>;
}

type CompletionScheduler = ReturnType<typeof createGoalScheduler<CompletionWait, ReviewedGoalResponse>>;

async function scheduleCompletionReview(
	options: CompletionSchedulingOptions,
	scheduler: CompletionScheduler,
	waiting: CompletionWait,
	ctx: ExtensionContext,
	decision: Extract<ReviewedGoalResponse["decision"], { kind: "wait" }>,
): Promise<void> {
	const message = `Waiting: ${decision.reason}`;
	await scheduler.waitForAgentsOrScheduleReview(ctx, waiting, [], {
		onAgentWait: (reviewAt) => options.onStatus(ctx, message, reviewAt, decision.displayId),
		onAgentWake: () => options.onClearStatus(ctx.sessionManager.getSessionId()),
		onReviewScheduled: (reviewAt) => options.onStatus(ctx, message, reviewAt, decision.displayId),
	});
}

async function applyCompletionDecision(
	options: CompletionSchedulingOptions,
	scheduler: CompletionScheduler,
	reviewed: ReviewedGoalResponse,
	waiting: CompletionWait,
	ctx: ExtensionContext,
): Promise<void> {
	scheduler.clearSession(ctx.sessionManager.getSessionId());
	const decision = reviewed.decision;
	switch (decision.kind) {
		case "complete":
			options.onComplete(waiting, ctx);
			break;
		case "continue":
			options.onContinue(decision.instructions, decision.displayId);
			break;
		case "wait":
			await scheduleCompletionReview(options, scheduler, waiting, ctx, decision);
			break;
		case "pause":
			options.onStatus(ctx, `Goal waiting: ${decision.reason}`, undefined, decision.displayId);
			break;
		case "error":
			options.onStatus(ctx, `Goal review failed: ${decision.reason}`, undefined, decision.displayId);
			return;
		case "set":
			options.onStatus(
				ctx,
				`Goal review failed: unexpected set decision: ${decision.reason}`,
				undefined,
				decision.displayId,
			);
			return;
	}
	options.consumeReviewEvidence(ctx, waiting.goal, reviewed.evidenceCount);
}

function createReviewGuard(scheduler: CompletionScheduler, ctx: ExtensionContext): () => boolean {
	const epoch = scheduler.captureEpoch(ctx);
	return () => scheduler.isEpochCurrent(ctx, epoch);
}

export function createCompletionWaitScheduler(options: CompletionSchedulingOptions): CompletionWaitScheduler {
	let scheduler: CompletionScheduler;
	scheduler = createGoalScheduler<CompletionWait, ReviewedGoalResponse>({
		pi: options.pi,
		applyDecision: async (decision, waiting, ctx) =>
			applyCompletionDecision(options, scheduler, decision, waiting, ctx),
		isSameRunningGoal: options.isSameGoal,
		reportError: options.onError,
		reviewGoal: async (ctx, waiting, _terminalTurn, wakeEvidence) =>
			options.reviewGoal({
				ctx,
				kind: "goal_completion_review",
				payload: {
					objective: waiting.goal.objective,
					completionReport: waiting.completionReport,
					wakeEvidence,
				},
			}),
	});
	return {
		clearAll: () => scheduler.clearAll(),
		clearSession: (sessionId) => scheduler.clearSession(sessionId),
		createReviewGuard: (ctx) => createReviewGuard(scheduler, ctx),
		wait: async (goal, ctx, completionReport, statusReason, displayId) => {
			const message = `Waiting: ${statusReason}`;
			return scheduler.waitForAgentsOrScheduleReview(ctx, { goal, completionReport }, [], {
				onAgentWait: (reviewAt) => options.onStatus(ctx, message, reviewAt, displayId),
				onAgentWake: () => options.onClearStatus(ctx.sessionManager.getSessionId()),
				onReviewScheduled: (reviewAt) => options.onStatus(ctx, message, reviewAt, displayId),
			});
		},
	};
}

/** Builds the completion-wait scheduler for the goal extension: a completed goal hands over to the mission. */
export function createGoalCompletionScheduler(
	pi: ExtensionAPI,
	reviewGoal: GoalEvidenceReview,
	evidence: GoalReviewEvidenceController,
	status: SupervisorStatusController,
	goalWork: GoalWorkStarter,
): CompletionWaitScheduler {
	return createCompletionWaitScheduler({
		pi,
		reviewGoal,
		consumeReviewEvidence: evidence.consume,
		isSameGoal: (ctx, waiting) => goalMatchesReview(loadOrMigrateActiveGoal(ctx), waiting.goal),
		onComplete: (waiting, ctx) => {
			const goal = markGoalComplete(ctx, waiting.completionReport);
			if (goal) ctx.ui.notify(`Goal complete: ${goal.objective}`, "info");
			continueMission(ctx, goalWork);
		},
		onContinue: sendSupervisorInstructions.bind(undefined, pi),
		onStatus: status.append,
		onClearStatus: status.clearSession,
		onError: appendGoalSchedulingError.bind(undefined, status.append),
	});
}
