import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAssistantContentText } from "../../../src/core/assistant-narration.ts";
import { hasCurrentChildReport } from "./child-report.ts";

export function readCurrentChildAssistantText(
	messages: AgentMessage[],
	previousMessages: ReadonlySet<AgentMessage>,
): string | undefined {
	const currentMessages = messages.filter((message) => !previousMessages.has(message));
	const terminal = [...currentMessages].reverse().find((message) => message.role === "assistant");
	if (terminal?.stopReason === "error") {
		throw new Error(terminal.errorMessage || "Child model request ended with error");
	}
	if (!hasCurrentChildReport(currentMessages)) {
		throw new Error(
			"Cannot complete child task without a current-task report. Write the report as public assistant text or successfully send a nonblank body with contact_parent before completing.",
		);
	}
	let report: string | undefined;
	for (let index = currentMessages.length - 1; index >= 0; index -= 1) {
		const text = readReplyText(currentMessages[index]);
		if (text === undefined) {
			if (report !== undefined) return report;
			continue;
		}
		report = text;
		// A reply right after a tool-free reply answers the end_turn continuation request ("Your previous response
		// was already delivered"), so the earlier reply holds the report.
		if (!continuesToolFreeReply(currentMessages, index)) return report;
	}
	return report;
}

function readReplyText(message: AgentMessage | undefined): string | undefined {
	if (message?.role !== "assistant") return undefined;
	const text = message.content
		.map(getAssistantContentText)
		.filter((text): text is string => text !== undefined)
		.join("\n");
	return text.trim() ? text : undefined;
}

function continuesToolFreeReply(messages: AgentMessage[], index: number): boolean {
	const previous = messages[index - 1];
	return previous?.role === "assistant" && !previous.content.some((part) => part.type === "toolCall");
}
