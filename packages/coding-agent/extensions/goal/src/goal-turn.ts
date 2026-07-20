import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";

type GoalAssistantMessage = Extract<AgentEndEvent["messages"][number], { role: "assistant" }>;

export function findLastAssistantMessage(event: AgentEndEvent): GoalAssistantMessage | undefined {
	return event.messages.filter((message): message is GoalAssistantMessage => message.role === "assistant").at(-1);
}

export function didLastAssistantAbort(event: AgentEndEvent): boolean {
	return findLastAssistantMessage(event)?.stopReason === "aborted";
}

export function didLastAssistantReturnEmpty(event: AgentEndEvent): boolean {
	const lastAssistantMessage = findLastAssistantMessage(event);
	if (!lastAssistantMessage || lastAssistantMessage.stopReason === "aborted") return false;

	const text = lastAssistantMessage.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	const hasToolCall = lastAssistantMessage.content.some((part) => part.type === "toolCall");
	return text.length === 0 && !hasToolCall;
}
