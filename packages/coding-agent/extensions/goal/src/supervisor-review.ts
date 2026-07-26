import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";
import { requestSupervisorDecision } from "../../../src/supervisor/client.ts";
import {
	DEFAULT_SUPERVISOR_KB_DIR,
	resolveSupervisorProjectForCwd,
} from "../../../src/supervisor/project-resolver.ts";
import type { GoalSupervisorResponse, GoalSupervisorReview } from "./goal-types.ts";
import { appendSupervisorStatus } from "./rendering.ts";

const GOAL_REVIEW_TIMEOUT_MS = 60_000;
const WAITING_FOR_SUPERVISOR_STATUS = "Waiting for Supervisor…";

function supervisorReviewErrorReason(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	const reason = String(error).trim();
	return reason || "Unknown Supervisor review error";
}

export function withSupervisorReviewStatus(pi: ExtensionAPI, reviewGoal: GoalSupervisorReview): GoalSupervisorReview {
	return async (input) => {
		appendSupervisorStatus(pi, WAITING_FOR_SUPERVISOR_STATUS);
		try {
			return await reviewGoal(input);
		} catch (error) {
			return { kind: "error", reason: supervisorReviewErrorReason(error) };
		}
	};
}

export async function reviewGoalWithResidentSupervisor(input: {
	kind: "goal_completion_review" | "goal_idle_review";
	payload: Record<string, unknown>;
	ctx: ExtensionContext;
}): Promise<GoalSupervisorResponse> {
	const kbDir = process.env.PI_KB_DIR ?? DEFAULT_SUPERVISOR_KB_DIR;
	const response = await requestSupervisorDecision({
		controlDbPath: getControlDbPath(),
		kind: input.kind,
		payload: input.payload,
		projectId: resolveSupervisorProjectForCwd(input.ctx.cwd, kbDir),
		senderSessionId: input.ctx.sessionManager.getSessionId(),
		timeoutMs: GOAL_REVIEW_TIMEOUT_MS,
	});
	switch (response.kind) {
		case "complete":
		case "continue":
		case "pause":
		case "wait":
		case "error":
			return response;
		default:
			return { kind: "error", reason: `Invalid goal review response: ${response.kind}` };
	}
}
