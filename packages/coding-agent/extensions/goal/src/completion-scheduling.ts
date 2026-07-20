import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal, GoalSupervisorResponse, GoalSupervisorReview } from "./goal-types.ts";
import { createGoalScheduler } from "./goal-scheduling.ts";

interface CompletionWait {
	goal: Goal;
	reason: string;
}

interface CompletionSchedulingOptions {
	pi: ExtensionAPI;
	reviewGoal: GoalSupervisorReview;
	isSameGoal: (ctx: ExtensionContext, waiting: CompletionWait) => boolean;
	onComplete: (waiting: CompletionWait, ctx: ExtensionContext) => void;
	onContinue: (instructions: string) => void;
	onStatus: (message: string) => void;
	onError: (error: unknown) => void;
}

export interface CompletionWaitScheduler {
	clearAll(): void;
	clearSession(sessionId: string): void;
	createReviewGuard(ctx: ExtensionContext): () => boolean;
	wait(goal: Goal, ctx: ExtensionContext, reason: string): Promise<void>;
}

type CompletionScheduler = ReturnType<typeof createGoalScheduler<CompletionWait, GoalSupervisorResponse>>;

async function applyCompletionDecision(
	options: CompletionSchedulingOptions,
	scheduler: CompletionScheduler,
	decision: GoalSupervisorResponse,
	waiting: CompletionWait,
	ctx: ExtensionContext,
): Promise<void> {
	scheduler.clearSession(ctx.sessionManager.getSessionId());
	switch (decision.kind) {
		case "complete":
			return options.onComplete(waiting, ctx);
		case "continue":
			return options.onContinue(decision.instructions);
		case "wait":
			options.onStatus(`Waiting: ${decision.reason}`);
			return scheduler.waitForAgentsOrScheduleReview(ctx, waiting, []);
		case "pause":
			return options.onStatus(`Goal waiting: ${decision.reason}`);
		case "error":
			return options.onStatus(`Goal review failed: ${decision.reason}`);
	}
}

function createReviewGuard(scheduler: CompletionScheduler, ctx: ExtensionContext): () => boolean {
	const epoch = scheduler.captureEpoch(ctx);
	return () => scheduler.isEpochCurrent(ctx, epoch);
}

export function createCompletionWaitScheduler(options: CompletionSchedulingOptions): CompletionWaitScheduler {
	let scheduler: CompletionScheduler;
	scheduler = createGoalScheduler<CompletionWait, GoalSupervisorResponse>({
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
					proposedCompletionReason: waiting.reason,
					wakeEvidence,
				},
			}),
	});
	return {
		clearAll: () => scheduler.clearAll(),
		clearSession: (sessionId) => scheduler.clearSession(sessionId),
		createReviewGuard: (ctx) => createReviewGuard(scheduler, ctx),
		wait: async (goal, ctx, reason) => scheduler.waitForAgentsOrScheduleReview(ctx, { goal, reason }, []),
	};
}
