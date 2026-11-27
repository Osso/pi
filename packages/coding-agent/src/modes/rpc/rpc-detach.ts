import type { AgentSession } from "../../core/agent-session.ts";

export function detachRunningTool(session: AgentSession): boolean {
	return session.hasDetachableTool && session.detachRunningTool();
}
