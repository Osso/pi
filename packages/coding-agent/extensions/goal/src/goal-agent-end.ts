import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal, GoalEvidenceReview, ReviewedGoalResponse } from "./goal-types.ts";

type TerminalTurn = AgentEndEvent["messages"];

interface GoalAgentEndOptions {
	event: AgentEndEvent;
	ctx: ExtensionContext;
	reviewGoal: GoalEvidenceReview;
	selectGoal: () => Goal | null;
	isSameGoal: (ctx: ExtensionContext, goal: Goal) => boolean;
	isReviewCurrent: () => boolean;
	applyDecision: (
		reviewed: ReviewedGoalResponse,
		goal: Goal,
		ctx: ExtensionContext,
		terminalTurn: TerminalTurn,
	) => Promise<void>;
	deferDecision: (
		reviewed: ReviewedGoalResponse,
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
	const reviewed = await options.reviewGoal({
		ctx: options.ctx,
		kind: "goal_idle_review",
		payload: { objective: goal.objective },
	});
	if (!reviewStillApplies(options, goal)) return;
	if (options.ctx.hasPendingMessages()) {
		options.deferDecision(reviewed, goal, options.ctx, options.event.messages);
		return;
	}
	await options.applyDecision(reviewed, goal, options.ctx, options.event.messages);
}
