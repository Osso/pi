import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai/compat";

/** Appended to an assistant message whose request a steer ended; gives replayed thinking the following item providers require. */
export const STEERING_INTERRUPTION_NOTE = "(Interrupted by a steering message.)";

/** Whether a content block is open after a streaming event: `*_start` opens one, `*_end` closes it. */
export function updateBlockOpen(open: boolean, eventType: AssistantMessageEvent["type"]): boolean {
	if (eventType === "thinking_start" || eventType === "text_start" || eventType === "toolcall_start") return true;
	if (eventType === "thinking_end" || eventType === "text_end" || eventType === "toolcall_end") return false;
	return open;
}

/**
 * A steer may end the request after a thinking or text block. A message with a tool call is left to finish,
 * because a cut-off tool call would have no result; the steer then arrives after the tool results.
 */
export function endsInterruptibleBlock(eventType: AssistantMessageEvent["type"], message: AssistantMessage): boolean {
	if (eventType !== "thinking_end" && eventType !== "text_end") return false;
	return !message.content.some((block) => block.type === "toolCall");
}
