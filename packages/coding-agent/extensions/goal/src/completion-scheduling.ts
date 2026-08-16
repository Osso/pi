import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal, GoalEvidenceReview, ReviewedGoalResponse } from "./goal-types.ts";
import { createGoalScheduler } from "./goal-scheduling.ts";

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
	onContinue: (instructions: string) => void;
	onStatus: (ctx: ExtensionContext, message: string, reviewAt?: string) => void;
	onClearStatus: (sessionId: string) => void;
	onError: (error: unknown, ctx: ExtensionContext) => void;
}

export interface CompletionWaitScheduler {
	clearAll(): void;
	clearSession(sessionId: string): void;
	createReviewGuard(ctx: ExtensionContext): () => boolean;
	wait(goal: Goal, ctx: ExtensionContext, completionReport: string, statusReason: string): Promise<void>;
}

type CompletionScheduler = ReturnType<typeof createGoalScheduler<CompletionWait, ReviewedGoalResponse>>;

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
			options.onContinue(decision.instructions);
			break;
		case "wait": {
			const message = `Waiting: ${decision.reason}`;
			await scheduler.waitForAgentsOrScheduleReview(ctx, waiting, [], {
				onAgentWait: (reviewAt) => options.onStatus(ctx, message, reviewAt),
				onAgentWake: () => options.onClearStatus(ctx.sessionManager.getSessionId()),
				onReviewScheduled: (reviewAt) => options.onStatus(ctx, message, reviewAt),
			});
			break;
		}
		case "pause":
			options.onStatus(ctx, `Goal waiting: ${decision.reason}`);
			break;
		case "error":
			options.onStatus(ctx, `Goal review failed: ${decision.reason}`);
			return;
		case "set":
			options.onStatus(ctx, `Goal review failed: unexpected set decision: ${decision.reason}`);
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
		wait: async (goal, ctx, completionReport, statusReason) => {
			const message = `Waiting: ${statusReason}`;
			return scheduler.waitForAgentsOrScheduleReview(ctx, { goal, completionReport }, [], {
				onAgentWait: (reviewAt) => options.onStatus(ctx, message, reviewAt),
				onAgentWake: () => options.onClearStatus(ctx.sessionManager.getSessionId()),
				onReviewScheduled: (reviewAt) => options.onStatus(ctx, message, reviewAt),
			});
		},
	};
}
