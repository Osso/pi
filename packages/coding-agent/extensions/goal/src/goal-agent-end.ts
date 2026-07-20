import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal, GoalSupervisorResponse, GoalSupervisorReview } from "./goal-types.ts";

type TerminalTurn = AgentEndEvent["messages"];

interface GoalAgentEndOptions {
	event: AgentEndEvent;
	ctx: ExtensionContext;
	reviewGoal: GoalSupervisorReview;
	selectGoal: () => Goal | null;
	isSameGoal: (ctx: ExtensionContext, goal: Goal) => boolean;
	isReviewCurrent: () => boolean;
	applyDecision: (
		decision: GoalSupervisorResponse,
		goal: Goal,
		ctx: ExtensionContext,
		terminalTurn: TerminalTurn,
	) => Promise<void>;
	deferDecision: (
		decision: GoalSupervisorResponse,
		goal: Goal,
		ctx: ExtensionContext,
		terminalTurn: TerminalTurn,
	) => void;
	deferReview: (goal: Goal, ctx: ExtensionContext, terminalTurn: TerminalTurn) => void;
}

function reviewStillApplies(options: GoalAgentEndOptions, goal: Goal): boolean {
	return options.isReviewCurrent() && options.isSameGoal(options.ctx, goal);
}

export async function handleGoalAgentEnd(options: GoalAgentEndOptions): Promise<void> {
	const goal = options.selectGoal();
	if (!goal) return;
	if (options.ctx.hasPendingMessages()) {
		options.deferReview(goal, options.ctx, options.event.messages);
		return;
	}
	const decision = await options.reviewGoal({
		ctx: options.ctx,
		kind: "goal_idle_review",
		payload: { objective: goal.objective, terminalTurn: options.event.messages },
	});
	if (!reviewStillApplies(options, goal)) return;
	if (options.ctx.hasPendingMessages()) {
		options.deferDecision(decision, goal, options.ctx, options.event.messages);
		return;
	}
	await options.applyDecision(decision, goal, options.ctx, options.event.messages);
}
