import { randomUUID } from "node:crypto";
import { enqueueStoredRuntimeMailboxMessage, type RuntimeMailboxMessage } from "../core/session-control-db.ts";
import { isRemoteHost, STORE_PATH, type SupervisorAddress } from "./mail.ts";

/**
 * Supervisor interrupts: the Supervisor stops a main session's running tool call and turn, and the session
 * continues with the interrupt message as its next prompt. Only the session's configured Supervisor is obeyed.
 */

const INTERRUPT_PREFIX = "supervisor_interrupt:";

export function isSupervisorInterrupt(message: RuntimeMailboxMessage): boolean {
	return message.storeRef.messageId.startsWith(INTERRUPT_PREFIX);
}

/**
 * True for an interrupt sent by `supervisor`, the recipient's configured Supervisor: its main session, and,
 * when it runs on another host, received through the relay from that host.
 */
export function isAuthorizedSupervisorInterrupt(
	message: RuntimeMailboxMessage,
	supervisor: Partial<SupervisorAddress> | undefined,
): boolean {
	if (!isSupervisorInterrupt(message) || !supervisor?.sessionId) return false;
	if (message.sender.sessionId !== supervisor.sessionId || message.sender.agentId !== null) return false;
	return isRemoteHost(supervisor.host) ? message.senderHost === supervisor.host : message.senderHost === undefined;
}

/** Queues an interrupt for a main session on this host, or on `target.host` through the relay. */
export function sendSupervisorInterrupt(
	controlDbPath: string,
	supervisorSessionId: string,
	target: { sessionId: string; host?: string },
	reason: string,
): void {
	const messageId = `${INTERRUPT_PREFIX}${target.sessionId}:${randomUUID()}`;
	const body = [
		`Supervisor interrupt: ${reason.trim()}`,
		"If a tool call or turn was running, the Supervisor stopped it. Continue your work with this in mind.",
	].join("\n");
	enqueueStoredRuntimeMailboxMessage(controlDbPath, {
		kind: "message",
		message: { body, id: messageId, kind: "message", status: "pending", fromAgentId: "main", toAgentId: "main" },
		recipient: { sessionId: target.sessionId, agentId: null },
		...(isRemoteHost(target.host) ? { recipientHost: target.host } : {}),
		sender: { sessionId: supervisorSessionId, agentId: null },
		storeRef: { messageId, sessionPath: STORE_PATH },
	});
}
