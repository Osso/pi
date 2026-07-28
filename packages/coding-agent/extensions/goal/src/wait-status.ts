import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalWaitCallbacks } from "./goal-scheduling.ts";
import type { AppendSupervisorStatus } from "./rendering.ts";

export function appendGoalSchedulingError(
	appendStatus: AppendSupervisorStatus,
	error: unknown,
	ctx: ExtensionContext,
): void {
	const message = error instanceof Error ? error.message : String(error);
	appendStatus(ctx, `Goal wait failed: ${message}`);
}

export function createWaitStatusCallbacks(
	appendStatus: AppendSupervisorStatus,
	ctx: ExtensionContext,
	message: string,
): GoalWaitCallbacks {
	return {
		onAgentWait: () => appendStatus(ctx, message),
		onReviewScheduled: (reviewAt) => appendStatus(ctx, message, reviewAt),
	};
}
