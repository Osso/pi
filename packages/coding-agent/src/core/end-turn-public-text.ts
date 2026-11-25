import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAssistantContentText } from "./assistant-narration.ts";
import type { SessionEntry } from "./session-manager.ts";

/** Returns messages after the latest user-role prompt, or undefined when no prompt exists. */
export function getMessagesAfterLatestUserPrompt(branch: readonly SessionEntry[]): AgentMessage[] | undefined {
	let promptIndex = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "user") {
			promptIndex = index;
			break;
		}
	}
	if (promptIndex < 0) return undefined;
	return branch.slice(promptIndex + 1).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

/** Checks whether ordered messages include nonblank public assistant prose. */
export function hasPublicAssistantText(messages: readonly AgentMessage[]): boolean {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (getAssistantContentText(part)?.trim()) return true;
		}
	}
	return false;
}
