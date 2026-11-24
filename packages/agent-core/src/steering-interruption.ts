import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "./types.ts";

/** Appended to an assistant message whose request a steer ended; gives replayed thinking the following item providers require. */
export const STEERING_INTERRUPTION_NOTE = "(Interrupted by a steering message.)";

/** Whether a thinking or text block is open after a streaming event. */
export function updateBlockOpen(open: boolean, eventType: AssistantMessageEvent["type"]): boolean {
	if (eventType === "thinking_start" || eventType === "text_start") return true;
	if (eventType === "thinking_end" || eventType === "text_end") return false;
	return open;
}

/** A steer never waits on a message with a tool call: it aborts the request, so the steered tool does not run. */
export function hasToolCall(message: AgentMessage | undefined): boolean {
	return message?.role === "assistant" && message.content.some((block) => block.type === "toolCall");
}

/**
 * A steer that waited for its block ends the request when a thinking or text block of a tool-free message ends.
 * Returns the content to keep: the blocks through the ended one (providers may already have appended later blocks to
 * the shared partial), then the note that gives replayed thinking the following item providers require.
 */
export function interruptedContentAfterBlock(
	event: AssistantMessageEvent,
	message: AssistantMessage,
): AssistantMessage["content"] | undefined {
	if (event.type !== "thinking_end" && event.type !== "text_end") return undefined;
	const content = message.content.slice(0, event.contentIndex + 1);
	if (content.some((block) => block.type === "toolCall")) return undefined;
	return [...content, { type: "text", text: STEERING_INTERRUPTION_NOTE }];
}
