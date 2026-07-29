import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type ManageGoalAction = "set" | "pause" | "resume" | "complete" | "clear" | "status";

export interface ManageGoalParams {
	action: ManageGoalAction;
	objective?: string;
	reason?: string;
	completionReport?: string;
}

type ManageGoalExecute = (params: ManageGoalParams, ctx: ExtensionContext) => Promise<AgentToolResult<unknown>>;

export function registerManageGoalTool(pi: ExtensionAPI, execute: ManageGoalExecute): void {
	pi.registerTool({
		name: "manage_goal",
		label: "Manage Goal",
		description:
			"Manage the active long-running /goal objective. Pause requires a concrete reason; complete requires a proof-backed completion report.",
		promptGuidelines: [],
		approvalRequired: false,
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("set"),
				Type.Literal("pause"),
				Type.Literal("resume"),
				Type.Literal("complete"),
				Type.Literal("clear"),
				Type.Literal("status"),
			]),
			objective: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String({ description: "Required when pausing; used to explain why work stopped." })),
			completionReport: Type.Optional(
				Type.String({
					description:
						"Required when completing; concise Markdown proof covering implementation, tests/checks, commits, deployment, smoke tests, and remaining blockers.",
				}),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => execute(params, ctx),
	});
}
