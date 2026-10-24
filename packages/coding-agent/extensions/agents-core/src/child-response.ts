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
	for (let index = currentMessages.length - 1; index >= 0; index -= 1) {
		const message = currentMessages[index];
		if (message?.role !== "assistant") continue;
		const text = message.content
			.map(getAssistantContentText)
			.filter((text): text is string => text !== undefined)
			.join("\n");
		if (text.trim()) return text;
	}
	return undefined;
}
