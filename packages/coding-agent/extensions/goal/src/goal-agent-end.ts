import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal, GoalSupervisorResponse, GoalSupervisorReview } from "./index.ts";

type TerminalTurn = AgentEndEvent["messages"];

interface GoalAgentEndOptions {
	event: AgentEndEvent;
	ctx: ExtensionContext;
	reviewGoal: GoalSupervisorReview;
	selectGoal: () => Goal | null;
	isSameGoal: (ctx: ExtensionContext, goal: Goal) => boolean;
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
}

export async function handleGoalAgentEnd(options: GoalAgentEndOptions): Promise<void> {
	const goal = options.selectGoal();
	if (!goal) return;
	const decision = await options.reviewGoal({
		ctx: options.ctx,
		kind: "goal_idle_review",
		payload: { objective: goal.objective, terminalTurn: options.event.messages },
	});
	if (!options.isSameGoal(options.ctx, goal)) return;
	if (options.ctx.hasPendingMessages()) {
		options.deferDecision(decision, goal, options.ctx, options.event.messages);
		return;
	}
	await options.applyDecision(decision, goal, options.ctx, options.event.messages);
}
