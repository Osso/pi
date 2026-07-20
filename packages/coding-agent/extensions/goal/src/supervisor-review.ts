import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "../../../src/config.ts";
import { getControlDbPath } from "../../../src/core/session-control-db.ts";
import { requestSupervisorDecision } from "../../../src/supervisor/client.ts";
import {
	DEFAULT_SUPERVISOR_KB_DIR,
	resolveSupervisorProjectForCwd,
} from "../../../src/supervisor/project-resolver.ts";
import type { GoalSupervisorResponse } from "./goal-types.ts";

const GOAL_REVIEW_TIMEOUT_MS = 180_000;

export async function reviewGoalWithResidentSupervisor(input: {
	kind: "goal_completion_review" | "goal_idle_review";
	payload: Record<string, unknown>;
	ctx: ExtensionContext;
}): Promise<GoalSupervisorResponse> {
	const kbDir = process.env.PI_KB_DIR ?? DEFAULT_SUPERVISOR_KB_DIR;
	const response = await requestSupervisorDecision({
		controlDbPath: getControlDbPath(getAgentDir()),
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
