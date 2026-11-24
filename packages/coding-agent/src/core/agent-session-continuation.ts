import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";

function findTrailingAssistantToolBatch(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === undefined) throw new Error("message missing while scanning session messages");
		if (message.role === "toolResult") continue;
		return message.role === "assistant" ? message : undefined;
	}
	return undefined;
}

type AssistantToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function isCompletedEndTurnBatch(messages: readonly AgentMessage[], toolCalls: readonly AssistantToolCall[]): boolean {
	if (toolCalls.length === 0 || toolCalls.some((toolCall) => toolCall.name !== "end_turn")) return false;
	return toolCalls.every((toolCall) =>
		messages.some((message) => {
			if (message.role !== "toolResult") return false;
			const matchesEndTurnResult = message.toolCallId === toolCall.id && message.toolName === "end_turn";
			return matchesEndTurnResult && !message.isError;
		}),
	);
}

export function shouldContinueInterruptedSession(messages: readonly AgentMessage[]): boolean {
	let lastMessageIndex = messages.length - 1;
	while (lastMessageIndex >= 0) {
		const message = messages[lastMessageIndex];
		if (message?.role !== "custom" || message.customType !== "self_restart") break;
		// The restart cut off a run whose last input may be any message kind, such as a loop prompt.
		if ((message.details as { interruptedRun?: unknown } | undefined)?.interruptedRun === true) return true;
		lastMessageIndex -= 1;
	}
	const relevantMessages = messages.slice(0, lastMessageIndex + 1);
	const lastMessage = relevantMessages[relevantMessages.length - 1];
	if (lastMessage?.role === "user") return true;
	if (lastMessage?.role !== "assistant" && lastMessage?.role !== "toolResult") return false;
	const assistant =
		lastMessage.role === "assistant" ? lastMessage : findTrailingAssistantToolBatch(relevantMessages.slice(0, -1));
	if (!assistant) return lastMessage.role === "toolResult";
	if (assistant.stopReason === "aborted") return true;
	// An output-limit stop is terminal: its tool calls never ran and the run settled (end-turn-tool spec).
	if (assistant.stopReason === "length") return false;
	const toolCalls = assistant.content.filter((content) => content.type === "toolCall");
	if (isCompletedEndTurnBatch(relevantMessages, toolCalls)) return false;
	return toolCalls.length > 0 && toolCalls.every((content) => content.name !== "resume_session");
}

interface RestorableSession {
	readonly messages: readonly AgentMessage[];
	consumeResumeContinuationRequest(): boolean;
	continue(): Promise<void>;
}

/** Headless startup and session switch: continue when an extension asked for it or the restored run was interrupted. */
export function continueRestoredSession(session: RestorableSession): void {
	if (!session.consumeResumeContinuationRequest() && !shouldContinueInterruptedSession(session.messages)) return;
	void session.continue().catch((error: unknown) => {
		process.stderr.write(
			`Failed to continue restored session: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	});
}
