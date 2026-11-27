import type { AgentSession } from "../../core/agent-session.ts";
import type { SessionManager } from "../../core/session-manager.ts";

/**
 * When each tool call on the current branch started, by tool call ID: the time its assistant
 * message was appended (the message's own `timestamp` is when it began streaming).
 */
function toolCallStarts(sessionManager: SessionManager): Record<string, number> {
	const starts: Record<string, number> = {};
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const at = Date.parse(entry.timestamp);
		for (const block of entry.message.content) if (block.type === "toolCall") starts[block.id] = at;
	}
	return starts;
}

/** The `get_messages` response data: the conversation and its tool call start times. */
export function rpcMessages(session: AgentSession) {
	return { messages: session.messages, toolCallStarts: toolCallStarts(session.sessionManager) };
}
