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

function omitFields<T extends object, K extends string>(value: T, fields: readonly K[]): DistributiveOmit<T, K> {
	const excludedFields = new Set<string>(fields);
	const entries = Object.entries(value).filter(([key]) => !excludedFields.has(key));
	return Object.fromEntries(entries) as DistributiveOmit<T, K>;
}

/** Shape only print-mode JSON; subscribed session events remain untouched. */
export function toJsonPrintModeEvent(event: AgentSessionEvent): JsonPrintModeEvent {
	switch (event.type) {
		case "message_start":
			return {
				...event,
				message: omitFields(event.message, [
					"content",
					"details",
					"summary",
					"output",
					"providerNative",
					"imageGenerationResult",
				]),
			};
		case "message_update":
			return {
				...omitFields(event, ["message"]),
				assistantMessageEvent: omitFields(event.assistantMessageEvent, [
					"partial",
					"content",
					"toolCall",
					"message",
					"error",
				]),
			};
		case "turn_end":
			return omitFields(event, ["message", "toolResults"]);
		case "agent_end":
			return omitFields(event, ["messages"]);
		case "tool_execution_end": {
			// The loop copies content/details into the subsequent toolResult message.
			// Other result fields (notably terminate) have no message equivalent.
			const result = omitFields(event.result as AgentToolResult<unknown> & Record<string, unknown>, [
				"content",
				"details",
			]);
			return { ...event, result };
		}
		default:
			return event;
	}
}
