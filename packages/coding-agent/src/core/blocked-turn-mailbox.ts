import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isAuthorizedSupervisorInterrupt } from "../supervisor/interrupt.ts";
import type { SupervisorAddress } from "../supervisor/mail.ts";
import {
	hasPendingRuntimeMailboxMessage,
	type RuntimeMailboxAddress,
	type RuntimeMailboxMessage,
} from "./session-control-db.ts";
import type { ToolDetachRegistry } from "./tool-detach-registry.ts";

/** When the running turn began: its last user message. A turn without one started before any interrupt. */
function readTurnStartedAt(messages: readonly AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "user") return message.timestamp;
	}
	return 0;
}

/**
 * Mail for a session whose turn has no checkpoint to deliver it, such as one blocked in a long tool call.
 * Returns "interrupt" when the configured Supervisor asked a main session to stop this turn: an interrupt sent
 * before the turn began was meant for an earlier one, so it waits and arrives as a message when the session is
 * idle. Otherwise a pending steer moves detachable running tools to background jobs, so their detached results
 * reach the next checkpoint at once.
 */
export function readBlockedTurnMailboxAction(input: {
	controlDbPath: string;
	recipient: RuntimeMailboxAddress;
	messages: readonly AgentMessage[];
	supervisor: Partial<SupervisorAddress> | undefined;
	toolDetachRegistry: ToolDetachRegistry | undefined;
}): "interrupt" | undefined {
	const { controlDbPath, recipient, supervisor, toolDetachRegistry } = input;
	if (recipient.agentId === null && supervisor?.sessionId !== undefined) {
		const turnStartedAt = readTurnStartedAt(input.messages);
		const stopsThisTurn = (message: RuntimeMailboxMessage) =>
			isAuthorizedSupervisorInterrupt(message, supervisor) && Date.parse(message.createdAt) >= turnStartedAt;
		if (hasPendingRuntimeMailboxMessage(controlDbPath, recipient, stopsThisTurn)) return "interrupt";
	}
	if (!toolDetachRegistry?.hasRunning()) return undefined;
	const steerPending = hasPendingRuntimeMailboxMessage(
		controlDbPath,
		recipient,
		(message) => message.kind === "steer" && message.targetCheckpoint !== "when_waiting",
	);
	if (steerPending) toolDetachRegistry.detachAll();
	return undefined;
}
