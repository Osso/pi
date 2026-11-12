import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const GOAL_CONTINUE_PROMPT = "Continue working toward the active goal.";

/**
 * The only path that sends the generic goal prompt. At most one prompt is outstanding per session:
 * a run in progress gets none because its agent_end review continues the goal, and a sent prompt
 * blocks another until the run it starts begins.
 */
export interface GoalWorkStarter {
	start(ctx: ExtensionContext): void;
	runStarted(ctx: ExtensionContext): void;
	/** Marks the goal agent_end handler, where the run is over but the session is not idle yet. */
	runEnding<T>(ctx: ExtensionContext, handleAgentEnd: () => Promise<T>): Promise<T>;
	clearAll(): void;
}

export function createGoalWorkStarter(pi: ExtensionAPI): GoalWorkStarter {
	const pendingStarts = new Set<string>();
	const endingRuns = new Set<string>();
	return {
		start(ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (pendingStarts.has(sessionId) || ctx.hasPendingMessages()) return;
			if (!ctx.isIdle() && !endingRuns.has(sessionId)) return;
			pendingStarts.add(sessionId);
			pi.sendUserMessage(GOAL_CONTINUE_PROMPT, { deliverAs: "followUp" });
		},
		runStarted(ctx) {
			pendingStarts.delete(ctx.sessionManager.getSessionId());
		},
		async runEnding(ctx, handleAgentEnd) {
			const sessionId = ctx.sessionManager.getSessionId();
			endingRuns.add(sessionId);
			try {
				return await handleAgentEnd();
			} finally {
				endingRuns.delete(sessionId);
			}
		},
		clearAll() {
			pendingStarts.clear();
			endingRuns.clear();
		},
	};
}
