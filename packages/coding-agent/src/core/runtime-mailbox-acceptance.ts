import { closeSync, fsyncSync, openSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	mailboxStoreRefsEqual,
	RUNTIME_MAILBOX_ACCEPTANCE_CUSTOM_TYPE,
	readAcceptedRuntimeMailboxStoreRefs,
} from "./runtime-mailbox-transcript.ts";
import {
	deliverRuntimeMailboxMessage,
	type RuntimeMailboxMessage,
	readRuntimeMailboxMessageForDelivery,
	releaseRuntimeMailboxMessageClaim,
} from "./session-control-db.ts";
import type { SessionManager } from "./session-manager.ts";

export type RuntimeMailboxAcceptanceRef = Pick<RuntimeMailboxMessage, "id" | "storeRef">;

const persistedMessages = new WeakSet<AgentMessage>();

export function isRuntimeMailboxMessagePersisted(message: AgentMessage): boolean {
	return persistedMessages.has(message);
}

export function acceptRuntimeMailboxMessages(
	sessionManager: SessionManager,
	controlDbPath: string,
	messages: RuntimeMailboxAcceptanceRef[],
	acceptedMessage?: AgentMessage,
): void {
	if (messages.length === 0) return;
	const sessionPath = sessionManager.getSessionFile();
	if (!sessionManager.isPersisted() || !sessionPath)
		throw new Error("Mailbox acceptance requires a persisted recipient session");
	// Flush even before the first assistant response. Message and marker share one JSONL record.
	sessionManager.persistForRecovery();
	const mailboxStoreRefs = messages.map((message) => message.storeRef);
	if (acceptedMessage) {
		if (acceptedMessage.role !== "user" && acceptedMessage.role !== "toolResult")
			throw new Error("Invalid mailbox acceptance message");
		sessionManager.appendMessage(acceptedMessage, mailboxStoreRefs);
		persistedMessages.add(acceptedMessage);
	} else {
		sessionManager.appendCustomEntry(RUNTIME_MAILBOX_ACCEPTANCE_CUSTOM_TYPE, { mailboxStoreRefs });
	}
	const fd = openSync(sessionPath, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	for (const message of messages) {
		const snapshot = readRuntimeMailboxMessageForDelivery(controlDbPath, message.id);
		if (snapshot?.payloadValid && mailboxStoreRefsEqual(snapshot.message.storeRef, message.storeRef)) {
			deliverRuntimeMailboxMessage(controlDbPath, message.id, snapshot.payloadData);
		}
	}
}

/** Accepted claims survive a failed delete; unaccepted claims can be retried in this process. */
export function releaseUnacceptedRuntimeMailboxMessages(
	sessionManager: SessionManager,
	controlDbPath: string,
	messages: RuntimeMailboxAcceptanceRef[],
): void {
	if (messages.length === 0) return;
	const accepted = readAcceptedRuntimeMailboxStoreRefs(sessionManager.getSessionFile());
	for (const message of messages) {
		if (accepted.some((ref) => mailboxStoreRefsEqual(ref, message.storeRef))) continue;
		releaseRuntimeMailboxMessageClaim(controlDbPath, message.id);
	}
}

export interface RuntimeMailboxToolDelivery {
	controlDbPath: string;
	messages: RuntimeMailboxAcceptanceRef[];
}

export function readRuntimeMailboxToolDelivery(message: AgentMessage): RuntimeMailboxToolDelivery | undefined {
	if (message.role !== "toolResult" || !message.details || typeof message.details !== "object") return undefined;
	if (!("runtimeMailboxDelivery" in message.details)) return undefined;
	return message.details.runtimeMailboxDelivery as RuntimeMailboxToolDelivery | undefined;
}
