import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type RuntimeMessageMarker = "duplicate_turn_assistant" | "duplicate_turn_guard";

const runtimeMessageMarkers = new WeakMap<AgentMessage, RuntimeMessageMarker>();

export function markDuplicateTurnAssistantMessage(message: AgentMessage): void {
	runtimeMessageMarkers.set(message, "duplicate_turn_assistant");
}

export function markDuplicateTurnGuardMessage(message: AgentMessage): void {
	runtimeMessageMarkers.set(message, "duplicate_turn_guard");
}

export function getRuntimeMessageMarker(message: AgentMessage): RuntimeMessageMarker | undefined {
	return runtimeMessageMarkers.get(message);
}

export function isDuplicateTurnAssistantMessage(
	message: AgentMessage,
	runtimeMessageMarker?: RuntimeMessageMarker,
): boolean {
	return (
		getRuntimeMessageMarker(message) === "duplicate_turn_assistant" ||
		runtimeMessageMarker === "duplicate_turn_assistant"
	);
}

export function isDuplicateTurnGuardMessage(
	message: AgentMessage,
	runtimeMessageMarker?: RuntimeMessageMarker,
): boolean {
	return getRuntimeMessageMarker(message) === "duplicate_turn_guard" || runtimeMessageMarker === "duplicate_turn_guard";
}
