import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EmptyResponseScheduler } from "./empty-response-scheduling.ts";
import { handleGoalAgentEnd } from "./goal-agent-end.ts";
import type { GoalScheduler } from "./goal-scheduling.ts";
import type { Goal, GoalSupervisorResponse, GoalSupervisorReview } from "./goal-types.ts";

type ApplyIdleDecision = (
	decision: GoalSupervisorResponse,
	goal: Goal,
	ctx: ExtensionContext,
	terminalTurn: AgentEndEvent["messages"],
) => Promise<void>;

interface ScheduledGoalAgentEndOptions {
	event: AgentEndEvent;
	ctx: ExtensionContext;
	reviewGoal: GoalSupervisorReview;
	scheduler: GoalScheduler<Goal, GoalSupervisorResponse>;
	emptyResponseScheduler: EmptyResponseScheduler<Goal>;
	applyDecision: ApplyIdleDecision;
	selectGoal: () => Goal | null;
	isSameGoal: (ctx: ExtensionContext, goal: Goal) => boolean;
}

export async function runScheduledGoalAgentEnd(options: ScheduledGoalAgentEndOptions): Promise<void> {
	const reviewEpoch = options.scheduler.captureEpoch(options.ctx);
	await handleGoalAgentEnd({
		event: options.event,
		ctx: options.ctx,
		reviewGoal: options.reviewGoal,
		selectGoal: options.selectGoal,
		isSameGoal: options.isSameGoal,
		isReviewCurrent: () => options.scheduler.isEpochCurrent(options.ctx, reviewEpoch),
		applyDecision: options.applyDecision,
		deferDecision: (decision, goal, pendingCtx, terminalTurn) =>
			options.scheduler.deferDecision(decision, goal, pendingCtx, terminalTurn),
		deferReview: (goal, pendingCtx, terminalTurn) =>
			options.scheduler.deferReview(goal, pendingCtx, terminalTurn),
	});
}
