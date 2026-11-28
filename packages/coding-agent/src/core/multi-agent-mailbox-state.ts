import { isMailboxMessageExpired } from "./mailbox-retention.ts";
import { copyAgent, copyFileRefs, copyMessage, validateFileRefs } from "./multi-agent-snapshots.ts";
import type { MultiAgentStore } from "./multi-agent-store.ts";
import type {
	AgentFileReference,
	AgentLifecycleNotificationInput,
	AgentLifecycleNotificationLifecycle,
	AgentLifecycleState,
	AgentMailboxMessage,
	AgentNode,
	AgentSnapshot,
	ContactParentInput,
	MailboxMessageCommandResult,
	ParentContactResult,
	PendingLifecycleNotification,
	SendMailboxMessageInput,
	SendSteeringInput,
} from "./multi-agent-types.ts";
import {
	COMPLETION_NOTIFICATION_THREAD_PREFIX,
	FAILED_NOTIFICATION_THREAD_PREFIX,
	LIFECYCLE_NOTIFICATION_LIFECYCLES,
	MAIN_THREAD_AGENT_ID,
	TERMINAL_STATES,
	WAITING_FOR_INPUT_NOTIFICATION_THREAD_PREFIX,
} from "./multi-agent-types.ts";
import {
	consumeRuntimeMailboxMessageByStoreRef,
	listLiveMultiAgentMailboxMessageIds,
	markMultiAgentMailboxMessageFailed,
	upsertMultiAgentMailboxMessage,
} from "./session-control-db.ts";

export function prepareSteeringMessageForLifecycleCoordinator(
	store: MultiAgentStore,
	agentId: string,
	input: SendSteeringInput,
): AgentMailboxMessage {
	const timestamp = store.now();
	return {
		body: input.body,
		createdAt: timestamp,
		fileRefs: validateFileRefs(input.fileRefs, "steer_agent"),
		fromAgentId: input.fromAgentId,
		id: store.createMessageId(),
		kind: "steer",
		status: "pending",
		targetCheckpoint: input.targetCheckpoint,
		threadId: input.threadId,
		toAgentId: agentId,
		updatedAt: timestamp,
	};
}

export function publishLifecycleCoordinatorSteering(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	message: AgentMailboxMessage,
): void {
	const previous = store.agents.get(agent.id);
	const current = copyAgent(agent);
	if (!isMailboxMessageExpired(message.createdAt, Date.parse(store.now()))) {
		store.mailboxMessages.set(message.id, copyMessage(message));
	}
	store.agents.set(agent.id, current);
	store.notifyAgentUpdateListeners(previous, current);
	if (!previous) return;
	store.notifyTransitionListenersIfLifecycleChanged(previous, current);
}

export function publishLifecycleCoordinatorSteeringDelivery(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	message: AgentMailboxMessage,
): void {
	store.mailboxMessages.delete(message.id);
	publishLifecycleCoordinatorSnapshot(store, agent);
}

export function publishLifecycleCoordinatorSnapshot(store: MultiAgentStore, agent: AgentSnapshot): void {
	const previous = store.agents.get(agent.id);
	const current = copyAgent(agent);
	store.agents.set(agent.id, current);
	store.notifyAgentUpdateListeners(previous, current);
	if (!previous) {
		store.clearSelectedTerminalAgent(current);
		return;
	}
	if (previous.lifecycle !== current.lifecycle) {
		if (current.lifecycle === "waiting_for_input") recordWaitingForInputNotification(store, current);
		store.notifyTransitionListenersIfLifecycleChanged(previous, current);
	}
	store.clearSelectedTerminalAgent(current);
}

export function publishTerminalOutboxSnapshot(store: MultiAgentStore, agent: AgentSnapshot): void {
	const previous = store.agents.get(agent.id);
	const current = copyAgent(agent);
	store.agents.set(agent.id, current);
	if (current.suppressTerminalNotification !== true) {
		if (current.lifecycle === "completed") retryOrRecordTerminalNotification(store, current, "completed");
		if (current.lifecycle === "failed" || current.lifecycle === "aborted") {
			retryOrRecordTerminalNotification(store, current, "failed");
		}
	}
	store.notifyAgentUpdateListeners(previous, current);
	if (!previous) {
		store.clearSelectedTerminalAgent(current);
		return;
	}
	store.notifyTransitionListenersIfLifecycleChanged(previous, current);
	store.clearSelectedTerminalAgent(current);
}

export function expireMailboxMessages(store: MultiAgentStore, now: number): void {
	if (store.mailboxMessages.size === 0) return;
	const liveIds = store.persistence
		? listLiveMultiAgentMailboxMessageIds(store.persistence.controlDbPath, store.persistence.sessionPath)
		: undefined;
	for (const [id, message] of store.mailboxMessages) {
		if (isMailboxMessageExpired(message.createdAt, now) || (liveIds && !liveIds.has(id))) {
			store.mailboxMessages.delete(id);
		}
	}
}

export function listMailboxMessages(store: MultiAgentStore): AgentMailboxMessage[] {
	expireMailboxMessages(store, Date.parse(store.now()));
	return Array.from(store.mailboxMessages.values(), copyMessage);
}

export function listPendingMailboxMessagesForAgent(store: MultiAgentStore, agentId: string): AgentMailboxMessage[] {
	return listMailboxMessages(store).filter((message) => message.toAgentId === agentId && message.status === "pending");
}

export function markMailboxMessageDelivered(
	store: MultiAgentStore,
	messageId: string,
): AgentMailboxMessage | undefined {
	const message = store.mailboxMessages.get(messageId);
	if (!message || isMailboxMessageExpired(message.createdAt, Date.parse(store.now()))) return undefined;
	if (store.persistence) {
		consumeRuntimeMailboxMessageByStoreRef(store.persistence.controlDbPath, {
			messageId,
			sessionPath: store.persistence.sessionPath,
		});
	}
	store.mailboxMessages.delete(messageId);
	return copyMessage(message);
}

export function markMailboxMessageFailed(
	store: MultiAgentStore,
	messageId: string,
	error: string,
): AgentMailboxMessage | undefined {
	const message = store.mailboxMessages.get(messageId);
	if (!message || message.status !== "pending") return undefined;
	if (isMailboxMessageExpired(message.createdAt, Date.parse(store.now()))) {
		return undefined;
	}

	if (
		store.persistence &&
		!markMultiAgentMailboxMessageFailed(
			store.persistence.controlDbPath,
			store.persistence.sessionPath,
			messageId,
			error,
		)
	) {
		store.mailboxMessages.delete(messageId);
		return undefined;
	}
	const updated = { ...message, error, status: "failed" as const, updatedAt: store.now() };
	store.mailboxMessages.set(messageId, updated);
	return copyMessage(updated);
}

export function consumeCompletionNotificationsForAgent(store: MultiAgentStore, agentId: string): AgentMailboxMessage[] {
	return consumeLifecycleNotificationsForAgent(store, agentId, "completed");
}

export function consumeFailureNotificationsForAgent(store: MultiAgentStore, agentId: string): AgentMailboxMessage[] {
	return consumeLifecycleNotificationsForAgent(store, agentId, "failed");
}

export function consumeLifecycleNotificationsForAgent(
	store: MultiAgentStore,
	agentId: string,
	lifecycle: AgentLifecycleNotificationLifecycle,
): AgentMailboxMessage[] {
	const consumed: AgentMailboxMessage[] = [];
	for (const message of listMailboxMessages(store)) {
		if (!isPendingLifecycleNotification(message, agentId, lifecycle)) {
			continue;
		}
		const delivered = markMailboxMessageDelivered(store, message.id);
		if (delivered) consumed.push(delivered);
	}
	return consumed;
}

export function listPendingLifecycleNotificationsForAgent(
	store: MultiAgentStore,
	agentId: string,
	lifecycle: AgentLifecycleNotificationLifecycle,
): AgentMailboxMessage[] {
	return listMailboxMessages(store).filter((message) => isPendingLifecycleNotification(message, agentId, lifecycle));
}

export function listPendingLifecycleNotifications(store: MultiAgentStore): PendingLifecycleNotification[] {
	return listMailboxMessages(store).flatMap((message) => {
		const lifecycle = LIFECYCLE_NOTIFICATION_LIFECYCLES.find((candidate) =>
			isPendingLifecycleNotification(message, message.fromAgentId, candidate),
		);
		return lifecycle ? [{ agentId: message.fromAgentId, lifecycle, message }] : [];
	});
}

export function contactParent(store: MultiAgentStore, agentId: string, input: ContactParentInput): ParentContactResult {
	const current = store.agents.get(agentId);
	if (!current) {
		return { ok: false, error: "not_found", agentId };
	}

	const fileRefs = validateFileRefs(input.fileRefs, "contact_parent");

	const timestamp = store.now();
	const message: AgentMailboxMessage = {
		id: store.createMessageId(),
		threadId: input.threadId,
		fromAgentId: current.id,
		toAgentId: current.parentId ?? MAIN_THREAD_AGENT_ID,
		kind: "parent_request",
		status: "pending",
		createdAt: timestamp,
		updatedAt: timestamp,
		body: input.body,
		fileRefs,
	};
	putMailboxMessage(store, message);

	const updated = store.updateAgentMetadata(current, {
		lastActivity: { description: "Contacted parent" },
	});

	return { ok: true, agent: copyAgent(updated), message: copyMessage(message) };
}

export function sendMainThreadMailboxMessage(
	store: MultiAgentStore,
	input: SendMailboxMessageInput,
): MailboxMessageCommandResult {
	const target = store.agents.get(input.toAgentId);
	const mainThread = store.createMainThreadSnapshot();
	if (!target) {
		return { ok: false, error: "target_not_found", current: mainThread, targetId: input.toAgentId };
	}

	if (!store.isMainThreadChild(target)) {
		return { ok: false, error: "forbidden_target", current: mainThread, target: copyAgent(target) };
	}

	const timestamp = store.now();
	const message: AgentMailboxMessage = {
		id: store.createMessageId(),
		threadId: input.threadId,
		fromAgentId: MAIN_THREAD_AGENT_ID,
		toAgentId: target.id,
		kind: "message",
		status: "pending",
		createdAt: timestamp,
		updatedAt: timestamp,
		body: input.body,
		fileRefs: validateFileRefs(input.fileRefs, "send_agent_message"),
	};
	putMailboxMessage(store, message);

	const updated = store.updateAgentMetadata(target, {
		lastActivity: { description: "Received mailbox message" },
	});

	return { ok: true, agent: copyAgent(updated), message: copyMessage(message) };
}

export function sendMailboxMessage(
	store: MultiAgentStore,
	agentId: string,
	expectedRevision: number,
	input: SendMailboxMessageInput,
): MailboxMessageCommandResult {
	const current = store.agents.get(agentId);
	if (!current) {
		return { ok: false, error: "not_found", agentId };
	}

	const revisionCheck = store.checkRevision(current, expectedRevision);
	if (revisionCheck) {
		return revisionCheck;
	}

	const target = store.agents.get(input.toAgentId);
	// The main thread has no agent row; a main-thread child still has a direct edge to it.
	const toMainParent = input.toAgentId === MAIN_THREAD_AGENT_ID && store.isMainThreadChild(current);
	if (!target && !toMainParent) {
		return { ok: false, error: "target_not_found", current: copyAgent(current), targetId: input.toAgentId };
	}

	if (target && !store.canSendDirectMessage(current.id, target.id)) {
		return { ok: false, error: "forbidden_target", current: copyAgent(current), target: copyAgent(target) };
	}

	const timestamp = store.now();
	const message: AgentMailboxMessage = {
		id: store.createMessageId(),
		threadId: input.threadId,
		fromAgentId: current.id,
		toAgentId: input.toAgentId,
		kind: "message",
		status: "pending",
		createdAt: timestamp,
		updatedAt: timestamp,
		body: input.body,
		fileRefs: validateFileRefs(input.fileRefs, "send_agent_message"),
	};
	putMailboxMessage(store, message);

	const updated = store.updateAgentMetadata(current, {
		lastActivity: { description: "Sent mailbox message" },
	});

	return { ok: true, agent: copyAgent(updated), message: copyMessage(message) };
}

export function recordOutboundSessionMessage(
	store: MultiAgentStore,
	input: {
		fromAgentId: string;
		toAgentId: string;
		body: string;
		threadId?: string;
		fileRefs?: AgentFileReference[];
	},
): AgentMailboxMessage {
	const timestamp = store.now();
	const message: AgentMailboxMessage = {
		fileRefs: validateFileRefs(input.fileRefs, "record_outbound_session_message"),
		body: input.body,
		createdAt: timestamp,
		fromAgentId: input.fromAgentId,
		id: store.createMessageId(),
		kind: "message",
		status: "pending",
		threadId: input.threadId,
		toAgentId: input.toAgentId,
		updatedAt: timestamp,
	};
	putMailboxMessage(store, message);
	return copyMessage(message);
}

export function putMailboxMessage(store: MultiAgentStore, message: AgentMailboxMessage): void {
	if (isMailboxMessageExpired(message.createdAt, Date.parse(store.now()))) return;
	store.mailboxMessages.set(message.id, message);
	if (!store.persistence) {
		return;
	}
	upsertMultiAgentMailboxMessage(store.persistence.controlDbPath, store.persistence.sessionPath, message.id, message);
}

export function retryOrRecordTerminalNotification(
	store: MultiAgentStore,
	agent: AgentNode,
	lifecycle: Extract<AgentLifecycleNotificationLifecycle, "completed" | "failed">,
): void {
	const existing = listPendingLifecycleNotificationsForAgent(store, agent.id, lifecycle)[0];
	if (existing) {
		notifyLifecycleNotificationListeners(store, existing);
		return;
	}
	if (lifecycle === "completed") {
		recordCompletionNotification(store, agent);
		return;
	}
	recordFailureNotification(store, agent);
}

export function recordCompletionNotification(store: MultiAgentStore, agent: AgentNode): void {
	if (hasPendingLifecycleNotification(store, agent.id, "completed")) {
		return;
	}

	recordLifecycleNotification(store, agent, {
		body: formatCompletionNotificationBody(agent),
		fileRefs: copyFileRefs(agent.result?.fileRefs),
		threadId: completionNotificationThreadId(agent.id),
	});
}

export function recordFailureNotification(store: MultiAgentStore, agent: AgentNode): void {
	if (hasPendingLifecycleNotification(store, agent.id, "failed")) {
		return;
	}

	recordLifecycleNotification(store, agent, {
		body: formatFailureNotificationBody(agent),
		fileRefs: copyFileRefs(agent.result?.fileRefs),
		threadId: failedNotificationThreadId(agent.id),
	});
}

export function recordWaitingForInputNotification(store: MultiAgentStore, agent: AgentNode): void {
	if (hasPendingLifecycleNotification(store, agent.id, "waiting_for_input")) {
		return;
	}

	recordLifecycleNotification(store, agent, {
		body: formatWaitingForInputNotificationBody(agent),
		threadId: waitingForInputNotificationThreadId(agent.id),
	});
}

export function recordLifecycleNotification(
	store: MultiAgentStore,
	agent: AgentNode,
	input: AgentLifecycleNotificationInput,
): void {
	const timestamp = store.now();
	if (isMailboxMessageExpired(agent.updatedAt, Date.parse(timestamp))) return;
	const message: AgentMailboxMessage = {
		body: input.body,
		createdAt: timestamp,
		fromAgentId: agent.id,
		id: store.createMessageId(),
		kind: "system",
		status: "pending",
		threadId: input.threadId,
		toAgentId: agent.parentId ?? MAIN_THREAD_AGENT_ID,
		updatedAt: timestamp,
		fileRefs: validateFileRefs(input.fileRefs, "lifecycle_notification"),
	};
	putMailboxMessage(store, message);
	notifyLifecycleNotificationListeners(store, message);
}

export function notifyLifecycleNotificationListeners(store: MultiAgentStore, message: AgentMailboxMessage): void {
	const snapshot = copyMessage(message);
	for (const listener of store.lifecycleNotificationListeners) {
		try {
			listener(snapshot);
		} catch (error) {
			console.error("MultiAgentStore lifecycle notification listener failed:", error);
		}
	}
}

export function hasPendingLifecycleNotification(
	store: MultiAgentStore,
	agentId: string,
	lifecycle: AgentLifecycleNotificationLifecycle,
): boolean {
	for (const message of listMailboxMessages(store)) {
		if (isPendingLifecycleNotification(message, agentId, lifecycle)) {
			return true;
		}
	}

	return false;
}

function completionNotificationThreadId(agentId: string): string {
	return `${COMPLETION_NOTIFICATION_THREAD_PREFIX}:${agentId}`;
}

function failedNotificationThreadId(agentId: string): string {
	return `${FAILED_NOTIFICATION_THREAD_PREFIX}:${agentId}`;
}

function waitingForInputNotificationThreadId(agentId: string): string {
	return `${WAITING_FOR_INPUT_NOTIFICATION_THREAD_PREFIX}:${agentId}`;
}

function isPendingLifecycleNotification(
	message: AgentMailboxMessage,
	agentId: string,
	lifecycle: AgentLifecycleNotificationLifecycle,
): boolean {
	const isFromAgent = message.fromAgentId === agentId;
	const isLifecycleNotice =
		message.kind === "system" && message.threadId === lifecycleNotificationThreadId(agentId, lifecycle);
	return isFromAgent && isLifecycleNotice && message.status === "pending";
}

function lifecycleNotificationThreadId(agentId: string, lifecycle: AgentLifecycleNotificationLifecycle): string {
	switch (lifecycle) {
		case "completed":
			return completionNotificationThreadId(agentId);
		case "failed":
			return failedNotificationThreadId(agentId);
		case "waiting_for_input":
			return waitingForInputNotificationThreadId(agentId);
	}
}

function formatCompletionNotificationBody(agent: AgentNode): string {
	const summary = agent.result?.summary?.trim();
	const body = summary ? `${agent.displayName} completed: ${summary}` : `${agent.displayName} completed.`;
	return appendAgentDuration(body, agent.result?.durationMs);
}

function formatFailureNotificationBody(agent: AgentNode): string {
	const errorMessage = agent.error?.message.trim();
	const body = errorMessage ? `${agent.displayName} failed: ${errorMessage}` : `${agent.displayName} failed.`;
	return appendAgentDuration(body, agent.result?.durationMs);
}

function appendAgentDuration(body: string, durationMs: number | undefined): string {
	if (durationMs === undefined) {
		return body;
	}
	const separator = /[.!?]$/.test(body) ? " " : ". ";
	return `${body}${separator}Duration: ${durationMs}ms`;
}

function formatWaitingForInputNotificationBody(agent: AgentNode): string {
	return `${agent.displayName} is waiting for input.`;
}

export function isActiveLifecycle(lifecycle: AgentLifecycleState): boolean {
	return !TERMINAL_STATES.has(lifecycle);
}
