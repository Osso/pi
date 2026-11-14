import { randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { LifecycleCoordinator } from "../../../src/core/lifecycle-coordinator.ts";
import {
	type AgentMailboxMessage,
	type AgentSnapshot,
	isActiveLifecycle,
	type MultiAgentStore,
	type PendingLifecycleNotification,
} from "../../../src/core/multi-agent-store.ts";
import {
	formatRuntimeMailboxPrompt,
	formatSharedChannelPrompt,
} from "../../../src/core/runtime-coordination-format.ts";
import type { RuntimeMailboxToolDelivery } from "../../../src/core/runtime-mailbox-acceptance.ts";
import {
	advanceSharedChannelCursor,
	enqueueRuntimeMailboxMessage,
	hasPendingRuntimeCoordinationMessage,
	isRuntimeCoordinationMailboxMessage,
	listSharedChannelMessagesAfter,
	readActiveMultiAgentAgents,
	readMultiAgentAgents,
	readSharedChannelCursor,
	readSharedChannelTail,
	releaseRuntimeMailboxMessageClaim,
	resolveOwnMainRuntimeCoordinationRecipient,
	type SharedChannelMessage,
	takeRuntimeMailboxMessagesForDelivery,
} from "../../../src/core/session-control-db.ts";
import { deliverTerminalOutboxProjections } from "../../../src/core/terminal-outbox-delivery.ts";
import type { MultiAgentRuntimeHandles } from "./contracts.ts";
import {
	CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE,
	type PendingTerminalNotification,
	RUNTIME_COORDINATION_POLL_INTERVAL_MS,
	type RuntimeCoordinationRecipient,
	WAIT_AGENT_SLICE_MS,
	type WaitAgentsToolDetails,
	type WaitAgentsWakeUp,
	type WaitNotificationsWake,
} from "./contracts.ts";
import { emptyResult, formatAgentStatus, isChildAgentRuntime } from "./dispatch.ts";
import { buildRuntimeMailboxStoreRef, resolveRuntimeRecipient, result } from "./messaging.ts";
import { artifactRootForStore } from "./session-factories.ts";

export function createMultiAgentRuntimeHandles(): MultiAgentRuntimeHandles {
	return { dispatches: new Map(), ownerships: new Map(), sessions: new Map(), waitWakeListeners: new Set() };
}

export class WaitAgentsWakeWatcher {
	private readonly activeAgents: AgentSnapshot[];
	private readonly deadline: number | undefined;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly controlDbPath: string;
	private readonly recipient: RuntimeCoordinationRecipient | undefined;
	private readonly sessionPath: string;
	private readonly signal: AbortSignal | undefined;
	private readonly store: MultiAgentStore;
	private readonly waitWakeListeners: MultiAgentRuntimeHandles["waitWakeListeners"];
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private resolve: ((wake: WaitNotificationsWake) => void) | undefined;
	private settled = false;
	private unsubscribeAgentTransitions = () => {};
	private unsubscribeWakeUp = () => {};

	constructor(
		store: MultiAgentStore,
		activeAgents: AgentSnapshot[],
		controlDbPath: string,
		sessionPath: string,
		signal: AbortSignal | undefined,
		recipient: RuntimeCoordinationRecipient | undefined,
		runtimeHandles: MultiAgentRuntimeHandles,
	) {
		this.activeAgents = activeAgents;
		this.deadline =
			runtimeHandles.latestModelRequestStartedAt === undefined
				? undefined
				: runtimeHandles.latestModelRequestStartedAt + WAIT_AGENT_SLICE_MS;
		this.controlDbPath = controlDbPath;
		this.sessionPath = sessionPath;
		this.recipient = recipient;
		this.signal = signal;
		this.store = store;
		this.waitWakeListeners = runtimeHandles.waitWakeListeners;
	}

	wait(): Promise<WaitNotificationsWake> {
		if (this.signal?.aborted) {
			return Promise.resolve({ kind: "cancelled" });
		}
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.start();
		});
	}

	private start(): void {
		const trackedAgentIds = new Set(this.activeAgents.map((agent) => agent.id));
		if (trackedAgentIds.size === 0) {
			this.checkCoordination();
			if (!this.settled) this.finish({ kind: "none" });
			return;
		}
		const readTrackedTerminal = (): AgentSnapshot | undefined => {
			const agents = readMultiAgentAgents(this.controlDbPath, this.sessionPath, [...trackedAgentIds]);
			return agents.find((agent) => !isActiveLifecycle(agent.lifecycle));
		};
		this.unsubscribeAgentTransitions = this.store.subscribeAgentTransitions(() => {
			const terminal = readTrackedTerminal();
			if (terminal) this.finish({ agent: terminal, kind: "agent" });
		});
		const onWakeUp = (wakeUp: WaitAgentsWakeUp) => {
			if (wakeUp.agentId && !trackedAgentIds.has(wakeUp.agentId)) return;
			const terminal = readTrackedTerminal();
			if (terminal) {
				this.finish({ agent: terminal, kind: "agent" });
				return;
			}
			if (wakeUp.kind === "coordination") {
				this.finish({ kind: "coordination", prompt: wakeUp.coordinationPrompt });
				return;
			}
			this.finish({ kind: "wake_up", wakeUp });
		};
		this.waitWakeListeners.add(onWakeUp);
		this.unsubscribeWakeUp = () => this.waitWakeListeners.delete(onWakeUp);
		this.signal?.addEventListener("abort", this.onAbort, { once: true });
		this.startRuntimeCoordinationWatch(readTrackedTerminal);
		this.reconcileDeadDetachedRuntimes();

		const terminalAgent = readTrackedTerminal();
		if (terminalAgent) {
			this.finish({ agent: terminalAgent, kind: "agent" });
			return;
		}
		this.checkCoordination();
		this.startDeadlineTimer(readTrackedTerminal);
	}

	private startDeadlineTimer(readTrackedTerminal: () => AgentSnapshot | undefined): void {
		if (this.settled || this.deadline === undefined) return;
		const remainingMs = this.deadline - Date.now();
		if (remainingMs <= 0) {
			this.finish({ kind: "timeout" });
			return;
		}
		this.deadlineTimer = setTimeout(
			this.finishOnError(() => {
				const terminal = readTrackedTerminal();
				if (terminal) {
					this.finish({ agent: terminal, kind: "agent" });
					return;
				}
				this.checkCoordination();
				this.finish({ kind: "timeout" });
			}),
			remainingMs,
		);
	}

	private reconcileDeadDetachedRuntimes(): void {
		const nowIso = new Date().toISOString();
		const artifactRoot = artifactRootForStore(this.store);
		if (LifecycleCoordinator.reconcileDeadDetachedRuntimes(this.controlDbPath, nowIso, artifactRoot) === 0) return;
		deliverTerminalOutboxProjections({
			artifactRoot,
			claimId: randomUUID(),
			controlDbPath: this.controlDbPath,
			now: () => nowIso,
			store: this.store,
		});
	}

	private startRuntimeCoordinationWatch(readTrackedTerminal: () => AgentSnapshot | undefined): void {
		this.pollTimer = setInterval(
			this.finishOnError(() => {
				this.reconcileDeadDetachedRuntimes();
				const terminal = readTrackedTerminal();
				if (terminal) {
					this.finish({ agent: terminal, kind: "agent" });
					return;
				}
				this.checkCoordination();
				if (this.deadline !== undefined && Date.now() >= this.deadline) this.finish({ kind: "timeout" });
			}),
			RUNTIME_COORDINATION_POLL_INTERVAL_MS,
		);
	}

	/** Timer callbacks settle the wait with an error wake instead of throwing an uncaught exception. */
	private finishOnError(tick: () => void): () => void {
		return () => {
			try {
				tick();
			} catch (error) {
				this.finish({ error, kind: "error" });
			}
		};
	}

	private readonly onAbort = () => {
		this.finish({ kind: "cancelled" });
	};

	private readonly checkCoordination = () => {
		if (!this.recipient) return;
		try {
			if (hasPendingRuntimeCoordinationMessage(this.recipient.controlDbPath, this.recipient.address)) {
				this.finish({ kind: "coordination" });
			}
		} catch (error) {
			this.finish({ error, kind: "error" });
		}
	};

	private finish(wake: WaitNotificationsWake): void {
		if (this.settled) return;
		this.settled = true;
		this.cleanup();
		this.resolve?.(wake);
		this.resolve = undefined;
	}

	private cleanup(): void {
		if (this.deadlineTimer !== undefined) {
			clearTimeout(this.deadlineTimer);
			this.deadlineTimer = undefined;
		}
		this.unsubscribeAgentTransitions();
		this.unsubscribeWakeUp();
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		this.signal?.removeEventListener("abort", this.onAbort);
	}
}

export async function waitAgents(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	signal: AbortSignal | undefined,
	ctx?: ExtensionContext,
): Promise<AgentToolResult<WaitAgentsToolDetails>> {
	const wake = await waitNotifications(store, runtimeHandles, signal, ctx);
	return consumeNotifications(store, wake, ctx);
}

export async function waitNotifications(
	store: MultiAgentStore,
	runtimeHandles = createMultiAgentRuntimeHandles(),
	signal?: AbortSignal,
	ctx?: ExtensionContext,
): Promise<WaitNotificationsWake> {
	if (ctx && isChildAgentRuntime(ctx)) {
		return { kind: "unavailable", message: CHILD_ORCHESTRATION_UNAVAILABLE_MESSAGE };
	}
	if (ctx) mirrorPendingLifecycleRuntimeMailboxMessages(store, ctx);
	const persistence = store.getPersistenceTarget();
	if (!persistence) {
		return { kind: "unavailable", message: "wait_agent requires a persisted supervisor session." };
	}
	const pending = listPendingTerminalNotifications(store, persistence.controlDbPath, persistence.sessionPath);
	const [firstPending] = pending;
	if (firstPending) return { agent: firstPending.agent, kind: "agent" };
	return waitForAgentOrCoordination(
		store,
		persistence.controlDbPath,
		persistence.sessionPath,
		signal,
		runtimeCoordinationRecipient(ctx),
		runtimeHandles,
	);
}

export function consumeNotifications(
	store: MultiAgentStore,
	wake: WaitNotificationsWake,
	ctx?: ExtensionContext,
): AgentToolResult<WaitAgentsToolDetails> {
	switch (wake.kind) {
		case "cancelled":
			return result("Wait cancelled.", {});
		case "coordination": {
			if (wake.prompt) return result(wake.prompt, {});
			const coordination = takePendingWaitCoordination(runtimeCoordinationRecipient(ctx));
			return result(coordination?.prompt || "Coordination input changed before delivery.", {
				runtimeMailboxDelivery: coordination?.runtimeMailboxDelivery,
			});
		}
		case "error": {
			const message = wake.error instanceof Error ? wake.error.message : String(wake.error);
			return result(`Wait failed: ${message}`, {});
		}
		case "none":
			return emptyResult();
		case "timeout":
			return result(
				"Wait slice timed out: agents are still running. No agents were cancelled. You can wait again after the next model request.",
				{ timedOut: true as const },
			);
		case "unavailable":
			return result(wake.message, {});
		case "wake_up": {
			const agent = wake.wakeUp.agentId ? store.getAgent(wake.wakeUp.agentId) : undefined;
			const text = agent ? `Woken after steering ${agent.displayName}.` : "Woken after supervisor steering.";
			return result(text, { wakeUp: wake.wakeUp });
		}
	}
	const persistence = store.getPersistenceTarget();
	if (persistence) {
		const pending = consumePendingTerminalNotifications(store, persistence.controlDbPath, persistence.sessionPath);
		if (pending) return pending;
	}
	return result(formatAgentStatus(wake.agent), { agent: wake.agent });
}

export function runtimeCoordinationRecipient(
	ctx: ExtensionContext | undefined,
): RuntimeCoordinationRecipient | undefined {
	if (!ctx?.controlDbPath) return undefined;
	const address = resolveOwnMainRuntimeCoordinationRecipient(ctx.controlDbPath);
	if (!address) return undefined;
	return { address, controlDbPath: ctx.controlDbPath };
}

export function takePendingWaitCoordination(
	recipient: RuntimeCoordinationRecipient | undefined,
): { prompt: string; runtimeMailboxDelivery?: RuntimeMailboxToolDelivery } | undefined {
	if (!recipient) return undefined;
	const mailboxMessages = takeRuntimeMailboxMessagesForDelivery(
		recipient.controlDbPath,
		recipient.address,
		isRuntimeCoordinationMailboxMessage,
		Number.MAX_SAFE_INTEGER,
	);
	try {
		const channelMessages = takePendingWaitSharedChannelMessages(recipient);
		const sections = [
			...mailboxMessages.map((message) => formatRuntimeMailboxPrompt(message, recipient.address.sessionId)),
			...(channelMessages.length > 0
				? [formatSharedChannelPrompt(channelMessages, recipient.address.sessionId)]
				: []),
		];
		if (sections.length === 0) return undefined;
		return {
			prompt: sections.join("\n\n"),
			runtimeMailboxDelivery:
				mailboxMessages.length > 0
					? {
							controlDbPath: recipient.controlDbPath,
							messages: mailboxMessages.map(({ id, storeRef }) => ({ id, storeRef })),
						}
					: undefined,
		};
	} catch (error) {
		for (const message of mailboxMessages) releaseRuntimeMailboxMessageClaim(recipient.controlDbPath, message.id);
		throw error;
	}
}

export function takePendingWaitSharedChannelMessages(recipient: RuntimeCoordinationRecipient): SharedChannelMessage[] {
	if (recipient.address.agentId !== null) return [];
	const cursor = readSharedChannelCursor(recipient.controlDbPath, recipient.address);
	if (cursor === undefined) return [];
	const lastMessageId = readSharedChannelTail(recipient.controlDbPath);
	const messages = readSharedChannelMessagesThrough(recipient.controlDbPath, cursor, lastMessageId);
	advanceSharedChannelCursor(recipient.controlDbPath, recipient.address, lastMessageId);
	return messages.filter(
		(message) =>
			message.sender.agentId === null &&
			(message.originHost !== undefined || message.sender.sessionId !== recipient.address.sessionId),
	);
}

export function readSharedChannelMessagesThrough(
	controlDbPath: string,
	cursor: number,
	lastMessageId: number,
): SharedChannelMessage[] {
	const messages: SharedChannelMessage[] = [];
	let pageCursor = cursor;
	while (pageCursor < lastMessageId) {
		const page = listSharedChannelMessagesAfter(controlDbPath, pageCursor, undefined, lastMessageId);
		const lastPageMessage = page.at(-1);
		if (!lastPageMessage) break;
		messages.push(...page);
		pageCursor = lastPageMessage.id;
	}
	return messages;
}

export function listPendingTerminalNotifications(
	store: MultiAgentStore,
	controlDbPath: string,
	sessionPath: string,
): PendingTerminalNotification[] {
	const firstNotificationByAgent = new Map<string, PendingLifecycleNotification>();
	for (const notification of store.listPendingLifecycleNotifications()) {
		if (notification.lifecycle === "waiting_for_input" || firstNotificationByAgent.has(notification.agentId))
			continue;
		firstNotificationByAgent.set(notification.agentId, notification);
	}
	if (firstNotificationByAgent.size === 0) return [];
	const persistedAgents = readMultiAgentAgents(controlDbPath, sessionPath, [...firstNotificationByAgent.keys()]);
	return persistedAgents.flatMap((agent) => {
		const notification = firstNotificationByAgent.get(agent.id);
		return notification && notification.lifecycle === agent.lifecycle
			? [{ agent, message: notification.message }]
			: [];
	});
}

export function consumePendingTerminalNotifications(
	store: MultiAgentStore,
	controlDbPath: string,
	sessionPath: string,
): AgentToolResult<WaitAgentsToolDetails> | undefined {
	const pending = listPendingTerminalNotifications(store, controlDbPath, sessionPath);
	if (pending.length === 0) return undefined;

	for (const { message } of pending) store.markMailboxMessageDelivered(message.id);
	const agents = pending.map(({ agent }) => agent);
	const messages = pending.map(({ message }) => message);
	const text = pending.map(({ agent, message }) => message.body ?? formatAgentStatus(agent)).join("\n");
	return result(text, { agent: agents[0], agents, message: messages[0], messages });
}

export async function waitForAgentOrCoordination(
	store: MultiAgentStore,
	controlDbPath: string,
	sessionPath: string,
	signal: AbortSignal | undefined,
	recipient: RuntimeCoordinationRecipient | undefined,
	runtimeHandles: MultiAgentRuntimeHandles,
): Promise<WaitNotificationsWake> {
	if (signal?.aborted) return Promise.resolve({ kind: "cancelled" });
	return new WaitAgentsWakeWatcher(
		store,
		readActiveMultiAgentAgents(controlDbPath, sessionPath),
		controlDbPath,
		sessionPath,
		signal,
		recipient,
		runtimeHandles,
	).wait();
}

export function mirrorPendingLifecycleRuntimeMailboxMessages(store: MultiAgentStore, ctx: ExtensionContext): void {
	for (const { agentId, lifecycle, message } of store.listPendingLifecycleNotifications()) {
		if (store.getAgent(agentId)?.lifecycle !== lifecycle) continue;
		mirrorLifecycleRuntimeMailboxMessage(store, message, ctx);
	}
}

export function mirrorLifecycleRuntimeMailboxMessage(
	store: MultiAgentStore,
	notification: AgentMailboxMessage,
	ctx: ExtensionContext,
): void {
	if (!ctx.controlDbPath) {
		return;
	}
	const storeRef = buildRuntimeMailboxStoreRef(store, notification, ctx);
	if (!storeRef) {
		console.error(
			`Runtime mailbox requires a store persisted to the control DB; dropped lifecycle notification ${notification.id}.`,
		);
		return;
	}
	const agent = store.getAgent(notification.fromAgentId);
	if (
		agent?.detached === true &&
		agent.suppressTerminalNotification !== true &&
		(agent.lifecycle === "completed" || agent.lifecycle === "failed" || agent.lifecycle === "aborted")
	) {
		return;
	}
	const recipient = resolveRuntimeRecipient(store, notification, ctx);
	if (!recipient) return;
	const currentSessionId = ctx.sessionManager.getSessionId();
	const senderSessionId = agent?.transcript?.sessionId ?? currentSessionId;
	enqueueRuntimeMailboxMessage(ctx.controlDbPath, {
		kind: notification.kind,
		recipient,
		sender: {
			agentId: notification.fromAgentId,
			sessionId: senderSessionId,
		},
		storeRef,
	});
}
