import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "../../../src/core/extensions/types.ts";

const RESTART_NOTICE = "The agent process was restarted by tool request. Continue from the current session.";

export default function selfRestartExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "restart_self",
		label: "Restart Self",
		description: "Restart the current Pi agent runtime and resume the same session.",
		parameters: Type.Object({}),
		approvalRequired: true,
		promptGuidelines: [
			"Use this tool only when restarting Pi itself is necessary to pick up runtime or extension changes.",
			"After the restart, continue from the same session using the restart notice as the newest context.",
		],
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx): Promise<AgentToolResult<{ restarted: boolean }>> {
			await ctx.restart({ notice: RESTART_NOTICE });
			return {
				content: [{ type: "text", text: "Restart requested. Current session was reloaded." }],
				details: { restarted: true },
			};
		},
	});
}
