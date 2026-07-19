import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type ManageGoalAction = "set" | "pause" | "resume" | "complete" | "clear" | "status";

export interface ManageGoalParams {
	action: ManageGoalAction;
	objective?: string;
	reason?: string;
}

type ManageGoalExecute = (params: ManageGoalParams, ctx: ExtensionContext) => Promise<AgentToolResult<unknown>>;

export function registerManageGoalTool(pi: ExtensionAPI, execute: ManageGoalExecute): void {
	pi.registerTool({
		name: "manage_goal",
		label: "Manage Goal",
		description: "Manage the active long-running /goal objective.",
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
			reason: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => execute(params, ctx),
	});
}
