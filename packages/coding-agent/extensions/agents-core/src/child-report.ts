import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { getAssistantContentText } from "../../../src/core/assistant-narration.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
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

function findCurrentPromptIndex(branch: SessionEntry[]): number {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user") return index;
	}
	return -1;
}

function hasCurrentChildReport(branch: SessionEntry[]): boolean {
	const promptIndex = findCurrentPromptIndex(branch);
	if (promptIndex < 0) return false;
	const parentReportCalls = new Set<string>();
	for (const entry of branch.slice(promptIndex + 1)) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			if (message.content.some((part) => getAssistantContentText(part)?.trim())) return true;
			recordParentReportCalls(message, parentReportCalls);
		}
		if (message.role === "toolResult" && isDeliveredParentReport(message, parentReportCalls)) {
			return true;
		}
	}
	return false;
}

export function createChildEndTurnToolDefinition(): ReturnType<typeof createEndTurnToolDefinition> {
	const core = createEndTurnToolDefinition();
	const reportGuideline =
		"Before end_turn, provide a nonblank public assistant report for the current task or successfully send it with contact_parent. Private thinking and the end_turn reason are not reports.";
	return {
		...core,
		description: `${core.description} ${reportGuideline}`,
		promptGuidelines: [...(core.promptGuidelines ?? []), reportGuideline],
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			if (!hasCurrentChildReport(ctx.sessionManager.getBranch())) {
				throw new Error(
					"Cannot end child turn without a current-task report. Write the report as public assistant text or successfully send a nonblank body with contact_parent, then call end_turn again.",
				);
			}
			return core.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}
