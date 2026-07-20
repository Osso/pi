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
	wait(goal: Goal, ctx: ExtensionContext, reason: string): Promise<void>;
}

export function createCompletionWaitScheduler(options: CompletionSchedulingOptions): CompletionWaitScheduler {
	async function applyDecision(
		decision: GoalSupervisorResponse,
		waiting: CompletionWait,
		ctx: ExtensionContext,
	): Promise<void> {
		scheduler.clearSession(ctx.sessionManager.getSessionId());
		switch (decision.kind) {
			case "complete":
				options.onComplete(waiting, ctx);
				return;
			case "continue":
				options.onContinue(decision.instructions);
				return;
			case "wait":
				options.onStatus(`Waiting: ${decision.reason}`);
				await scheduler.waitForAgentsOrScheduleReview(ctx, waiting, []);
				return;
			case "pause":
				options.onStatus(`Goal waiting: ${decision.reason}`);
				return;
			case "error":
				options.onStatus(`Goal review failed: ${decision.reason}`);
		}
	}

	const scheduler = createGoalScheduler<CompletionWait, GoalSupervisorResponse>({
		pi: options.pi,
		applyDecision: async (decision, waiting, ctx) => applyDecision(decision, waiting, ctx),
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
		wait: async (goal, ctx, reason) => scheduler.waitForAgentsOrScheduleReview(ctx, { goal, reason }, []),
	};
}
