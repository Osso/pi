import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { getMessagesAfterLatestUserPrompt, hasPublicAssistantText } from "../../../src/core/end-turn-public-text.ts";
import { createEndTurnToolDefinition } from "../../../src/core/tools/end-turn.ts";

function isSuccessfulParentReport(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	if (!("message" in details)) return false;
	const message = details.message;
	if (!message || typeof message !== "object") return false;
	if (!("id" in message) || typeof message.id !== "string") return false;
	if (message.id.trim() === "") return false;
	if (!("status" in message)) return false;
	return message.status === "pending" || message.status === "claimed" || message.status === "accepted";
}

function recordParentReportCalls(message: AssistantMessage, parentReportCalls: Set<string>): void {
	for (const part of message.content) {
		if (part.type !== "toolCall" || part.name !== "contact_parent") continue;
		if (typeof part.arguments.body !== "string") continue;
		if (!part.arguments.body.trim()) continue;
		parentReportCalls.add(part.id);
	}
}

function isDeliveredParentReport(message: ToolResultMessage<unknown>, parentReportCalls: ReadonlySet<string>): boolean {
	if (message.toolName !== "contact_parent") return false;
	if (!parentReportCalls.has(message.toolCallId)) return false;
	if (message.isError) return false;
	return isSuccessfulParentReport(message.details);
}

/** Checks ordered messages already scoped to the current child task by the caller. */
export function hasCurrentChildReport(messages: AgentMessage[]): boolean {
	if (hasPublicAssistantText(messages)) return true;
	const parentReportCalls = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") recordParentReportCalls(message, parentReportCalls);
		if (message.role === "toolResult" && isDeliveredParentReport(message, parentReportCalls)) {
			return true;
		}
	}
	return false;
}

export function createChildEndTurnToolDefinition(): ReturnType<typeof createEndTurnToolDefinition> {
	const core = createEndTurnToolDefinition("child");
	const reportGuideline =
		"Before end_turn, provide a nonblank public assistant report for the current task or successfully send it with contact_parent. Private thinking and the end_turn reason are not reports.";
	return {
		...core,
		description: `${core.description} ${reportGuideline}`,
		promptGuidelines: [...(core.promptGuidelines ?? []), reportGuideline],
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const currentMessages = getMessagesAfterLatestUserPrompt(ctx.sessionManager.getBranch()) ?? [];
			if (!hasCurrentChildReport(currentMessages)) {
				throw new Error(
					"Cannot end child turn without a current-task report. Write the report as public assistant text or successfully send a nonblank body with contact_parent, then call end_turn again.",
				);
			}
			return core.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}
