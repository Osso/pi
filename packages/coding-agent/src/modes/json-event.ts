import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type MessageBodyKey = "content" | "details" | "summary" | "output" | "providerNative" | "imageGenerationResult";
type MessageMetadata = DistributiveOmit<AgentMessage, MessageBodyKey>;
type JsonAssistantMessageEvent = DistributiveOmit<
	AssistantMessageEvent,
	"partial" | "content" | "toolCall" | "message" | "error"
>;

type JsonEvent<T extends AgentSessionEvent> = T extends { type: "message_start" }
	? Omit<T, "message"> & { message: MessageMetadata }
	: T extends { type: "message_update" }
		? Omit<T, "message" | "assistantMessageEvent"> & { assistantMessageEvent: JsonAssistantMessageEvent }
		: T extends { type: "turn_end" }
			? Omit<T, "message" | "toolResults">
			: T extends { type: "agent_end" }
				? Omit<T, "messages">
				: T extends { type: "tool_execution_end" }
					? Omit<T, "result"> & { result: Record<string, unknown> }
					: T;

export type JsonPrintModeEvent = JsonEvent<AgentSessionEvent>;

function messageMetadata(message: AgentMessage): MessageMetadata {
	const { content, details, summary, output, providerNative, imageGenerationResult, ...metadata } =
		message as AgentMessage & Partial<Record<MessageBodyKey, unknown>>;
	return metadata;
}

function assistantEventMetadata(event: AssistantMessageEvent): JsonAssistantMessageEvent {
	const { partial, content, toolCall, message, error, ...metadata } = event as AssistantMessageEvent &
		Partial<Record<"partial" | "content" | "toolCall" | "message" | "error", unknown>>;
	return metadata;
}

/** Shape only print-mode JSON; subscribed session events remain untouched. */
export function toJsonPrintModeEvent(event: AgentSessionEvent): JsonPrintModeEvent {
	switch (event.type) {
		case "message_start":
			return { ...event, message: messageMetadata(event.message) };
		case "message_update": {
			const { message, assistantMessageEvent, ...metadata } = event;
			return { ...metadata, assistantMessageEvent: assistantEventMetadata(assistantMessageEvent) };
		}
		case "turn_end": {
			const { message, toolResults, ...metadata } = event;
			return metadata;
		}
		case "agent_end": {
			const { messages, ...metadata } = event;
			return metadata;
		}
		case "tool_execution_end": {
			// The loop copies content/details into the subsequent toolResult message.
			// Other result fields (notably terminate) have no message equivalent.
			const { content, details, ...result } = event.result as AgentToolResult<unknown> & Record<string, unknown>;
			return { ...event, result };
		}
		default:
			return event;
	}
}
