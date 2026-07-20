import type { AgentEndEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal } from "./goal-types.ts";
import { didLastAssistantAbort, didLastAssistantReturnEmpty, findLastAssistantMessage } from "./goal-turn.ts";

interface GoalIdleSelectionOptions {
	event: AgentEndEvent;
	ctx: ExtensionContext;
	selectGoal: () => Goal | null;
	clearRetry: (sessionId: string) => void;
	scheduleRetry: (ctx: ExtensionContext, goal: Goal) => void;
	scheduleErrorStatus: (ctx: ExtensionContext, message: string) => void;
	reportSkipped: (message: string) => void;
}

export function selectGoalForIdleReview(options: GoalIdleSelectionOptions): Goal | null {
	const goal = options.selectGoal();
	if (!goal) return null;
	const sessionId = options.ctx.sessionManager.getSessionId();
	if (didLastAssistantAbort(options.event)) {
		options.clearRetry(sessionId);
		const message = options.ctx.hasPendingMessages()
			? "Goal continuation deferred: pending input will run next."
			: "Goal continuation skipped: the model turn was aborted.";
		options.reportSkipped(message);
		return null;
	}
	if (findLastAssistantMessage(options.event)?.stopReason === "error") {
		options.clearRetry(sessionId);
		if (options.ctx.hasPendingMessages()) {
			options.reportSkipped("Goal continuation deferred: pending input will run next.");
		} else {
			options.scheduleErrorStatus(options.ctx, "Goal continuation skipped: the model turn ended with an error.");
		}
		return null;
	}
	if (didLastAssistantReturnEmpty(options.event)) {
		options.scheduleRetry(options.ctx, goal);
		return null;
	}
	options.clearRetry(sessionId);
	return goal;
}
