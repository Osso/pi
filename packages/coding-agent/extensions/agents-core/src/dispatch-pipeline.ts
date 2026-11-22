export type { MultiAgentRuntimeHandles } from "./contracts.ts";

export {
	createProductionAttachedSessionFactory,
	createProductionChildAgentSessionFactory,
} from "./session-factories.ts";

import { randomUUID } from "node:crypto";
import {
	type DesktopNotificationHandle,
	PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
	toDesktopNotificationHandle,
} from "../../../src/core/desktop-notification.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	type AgentMailboxMessage,
	type AgentSnapshot,
	isActiveLifecycle,
	type MultiAgentStore,
} from "../../../src/core/multi-agent-store.ts";
import { deliverTerminalOutboxProjections } from "../../../src/core/terminal-outbox-delivery.ts";
import { readCurrentChildAssistantText } from "./child-response.ts";
import type { ActiveAgentDispatches, BackgroundSessionHandles, OwnedAgentRuntime } from "./contracts.ts";
import { waitForActiveDescendants } from "./descendant-settlement.ts";
import { requestDirectDetachedRuntimeCancellations } from "./detached-runtime-cancellation.ts";
import { artifactRootForStore } from "./session-factories.ts";

export type {
	AgentDesktopNotification,
	AgentDesktopNotifier,
	AttachedSessionDispatchInput,
	AttachedSessionFactory,
	ChildAgentDispatchInput,
	ChildAgentSession,
	ChildAgentSessionFactory,
	MultiAgentExtensionOptions,
	MultiAgentPiRequestHandler,
	ProductionChildAgentSessionFactoryOptions,
} from "./contracts.ts";

import {
	type AgentDesktopNotifier,
	type ChildAgentSession,
	type ChildAgentSessionFactory,
	SUBAGENT_TERMINAL_CLEANUP_REASON,
} from "./contracts.ts";

export interface WaitingDesktopNotificationRegistration {
	handle: DesktopNotificationHandle;
	unsubscribeTransition: () => void;
}

export type WaitingDesktopNotificationHandles = Map<string, WaitingDesktopNotificationRegistration>;

export function startToolDispatch(
	store: MultiAgentStore,
	dispatches: ActiveAgentDispatches,
	agent: AgentSnapshot,
	dispatch: () => Promise<AgentSnapshot>,
	desktopNotifier: AgentDesktopNotifier,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
	handles: BackgroundSessionHandles | undefined,
	reservedRuntime: OwnedAgentRuntime,
): AgentSnapshot {
	const unsubscribeLifecycleNotifications = store.subscribeLifecycleNotifications((message) => {
		if (message.fromAgentId !== agent.id) {
			return;
		}
		const notificationHandle = notifyWaitingAgent(message, desktopNotifier);
		if (isWaitingForInputNotification(message)) {
			rememberWaitingDesktopNotification(store, message, notificationHandle, waitingDesktopNotifications);
		} else {
			closeWaitingDesktopNotification(message.fromAgentId, waitingDesktopNotifications);
		}
	});
	const trackedDispatch = trackAgentDispatch(store, dispatches, agent, dispatch(), reservedRuntime, handles);
	void trackedDispatch.finally(() => {
		unsubscribeLifecycleNotifications();
		closeWaitingDesktopNotificationWhenNotWaiting(store, agent.id, waitingDesktopNotifications);
	});

	return store.getAgent(agent.id) ?? agent;
}

export function trackAgentDispatch(
	store: MultiAgentStore,
	dispatches: ActiveAgentDispatches,
	agent: AgentSnapshot,
	dispatch: Promise<AgentSnapshot>,
	reservedRuntime: OwnedAgentRuntime,
	handles?: BackgroundSessionHandles,
): Promise<AgentSnapshot> {
	const restoreGeneration = store.getRestoreGeneration();
	const trackedDispatch = dispatch.catch((error: unknown) => {
		const current = store.getAgent(agent.id) ?? agent;
		return finalizeReservedRuntime(
			store,
			current,
			"failed",
			{ error: { message: error instanceof Error ? error.message : String(error) } },
			reservedRuntime,
			restoreGeneration,
		);
	});
	dispatches.set(agent.id, trackedDispatch);
	void trackedDispatch.finally(() => {
		if (dispatches.get(agent.id) === trackedDispatch) {
			handles?.delete(agent.id);
			dispatches.delete(agent.id);
		}
	});

	return trackedDispatch;
}

export async function runAgentSession(
	store: MultiAgentStore,
	createChildSession: ChildAgentSessionFactory,
	runningAgent: AgentSnapshot,
	prompt: string,
	ctx: ExtensionContext,
	handles: BackgroundSessionHandles | undefined,
	createdSession: ChildAgentSession | undefined,
	reservedRuntime: OwnedAgentRuntime,
	expectedRestoreGeneration?: number,
): Promise<AgentSnapshot> {
	const restoreGeneration = expectedRestoreGeneration ?? store.getRestoreGeneration();
	const running = { agent: runningAgent };
	let childSession: ChildAgentSession | undefined;
	let unregisterAbortHandler: (() => void) | undefined;
	let unregisterLeaseAbort: (() => void) | undefined;
	try {
		const activeSession =
			createdSession ??
			(await createChildSession({
				agent: running.agent,
				context: "fresh",
				ctx,
				prompt,
				signal: reservedRuntime.abortController.signal,
			}));
		childSession = activeSession;
		const leaseSignal = reservedRuntime.abortController.signal;
		const abortForLeaseLoss = () => {
			try {
				activeSession.abort?.();
			} catch (error) {
				console.error(`Failed to abort child session ${running.agent.id}:`, error);
			}
		};
		leaseSignal.addEventListener("abort", abortForLeaseLoss, { once: true });
		unregisterLeaseAbort = () => leaseSignal.removeEventListener("abort", abortForLeaseLoss);
		if (leaseSignal.aborted) activeSession.abort?.();
		const current = store.getAgent(running.agent.id);
		if (store.getRestoreGeneration() !== restoreGeneration || !current || !isActiveLifecycle(current.lifecycle)) {
			activeSession.abort?.();
			return current ?? running.agent;
		}

		unregisterAbortHandler = store.registerAgentAbortHandler(running.agent.id, () => {
			reservedRuntime.abortController.abort();
			handles?.delete(running.agent.id);
		});
		handles?.set(running.agent.id, activeSession);
		if (activeSession.transcript) {
			store.updateAgentTranscript(running.agent.id, activeSession.transcript);
		}
		const previousMessages = new Set(activeSession.messages);
		await activeSession.prompt(prompt);
		await settleDescendantsBeforeTerminalization(store, running.agent.id, reservedRuntime.abortController.signal);
		const cancelled = acknowledgeCancelledRuntime(store, running.agent.id, reservedRuntime, restoreGeneration);
		if (cancelled) return cancelled;
		await drainExploreConsultationResult(store, running.agent.id, activeSession);
		while (true) {
			const summary = readCurrentChildAssistantText(activeSession.messages, previousMessages);
			const result = summary ? { summary } : undefined;
			const currentSnapshot = store.getAgent(running.agent.id);
			const completed = finalizeReservedRuntime(
				store,
				currentSnapshot ?? running.agent,
				"completed",
				{ result },
				reservedRuntime,
				restoreGeneration,
			);
			if (completed.lifecycle !== "steering_pending") {
				return completed;
			}
			if (!activeSession.drainRuntimeCoordination) {
				throw new Error("Child session cannot drain pending steering before completion");
			}
			await activeSession.drainRuntimeCoordination();
			const current = store.getAgent(running.agent.id);
			if (current?.lifecycle === "steering_pending") {
				throw new Error("Child session did not deliver pending steering before completion");
			}
		}
	} catch (error) {
		await settleDescendantsBeforeTerminalization(store, running.agent.id);
		const cancelled = acknowledgeCancelledRuntime(store, running.agent.id, reservedRuntime, restoreGeneration);
		if (cancelled) return cancelled;
		const failure = { message: error instanceof Error ? error.message : String(error) };
		const current = store.getAgent(running.agent.id) ?? running.agent;
		return finalizeReservedRuntime(store, current, "failed", { error: failure }, reservedRuntime, restoreGeneration);
	} finally {
		unregisterLeaseAbort?.();
		unregisterAbortHandler?.();
		handles?.delete(running.agent.id);
		await childSession?.dispose?.();
	}
}

async function drainExploreConsultationResult(
	store: MultiAgentStore,
	parentId: string,
	session: ChildAgentSession,
): Promise<void> {
	// A recovered requester may finish its prompt before its restored consultation finishes.
	const hasConsultation = store.listDescendants(parentId).some((agent) => agent.exploreConsultation);
	if (hasConsultation) await session.drainRuntimeCoordination?.();
}

export async function settleDescendantsBeforeTerminalization(
	store: MultiAgentStore,
	agentId: string,
	signal?: AbortSignal,
): Promise<void> {
	requestDirectDetachedRuntimeCancellations(store, agentId, SUBAGENT_TERMINAL_CLEANUP_REASON);
	await waitForActiveDescendants(store, agentId, signal);
}

export function finalizeReservedRuntime(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	terminalLifecycle: "completed" | "failed" | "aborted",
	metadata: { error?: AgentSnapshot["error"]; result?: AgentSnapshot["result"] },
	reservedRuntime: OwnedAgentRuntime,
	expectedRestoreGeneration?: number,
): AgentSnapshot {
	if (expectedRestoreGeneration !== undefined && store.getRestoreGeneration() !== expectedRestoreGeneration)
		return agent;
	if (!isActiveLifecycle(agent.lifecycle)) return agent;
	const finalized = reservedRuntime.coordinator.finalizeChild({
		agent,
		error: metadata.error,
		ownership: reservedRuntime.lifecycle.ownership,
		result: metadata.result,
		terminalLifecycle,
	});
	if (!finalized.ok) return store.getAgent(agent.id) ?? agent;
	publishCoordinatorSnapshot(store, finalized.agent);
	return finalized.agent;
}

export function publishCoordinatorSnapshot(store: MultiAgentStore, agent: AgentSnapshot): void {
	store.publishLifecycleCoordinatorSnapshot(agent);
	if (isActiveLifecycle(agent.lifecycle)) return;
	deliverTerminalOutboxForStore(store);
}

export function deliverTerminalOutboxForStore(store: MultiAgentStore): number {
	const persistence = store.getPersistenceTarget();
	if (!persistence) return 0;
	return deliverTerminalOutboxProjections({
		artifactRoot: artifactRootForStore(store),
		claimId: randomUUID(),
		controlDbPath: persistence.controlDbPath,
		now: () => new Date().toISOString(),
		store,
	});
}

export function acknowledgeCancelledRuntime(
	store: MultiAgentStore,
	agentId: string,
	reservedRuntime: OwnedAgentRuntime | undefined,
	expectedRestoreGeneration?: number,
): AgentSnapshot | undefined {
	if (!reservedRuntime) return undefined;
	if (expectedRestoreGeneration !== undefined && store.getRestoreGeneration() !== expectedRestoreGeneration)
		return undefined;
	const current = store.getAgent(agentId);
	if (current?.lifecycle !== "cancelling") return undefined;
	const acknowledged = reservedRuntime.coordinator.acknowledgeCancellation({
		agent: current,
		ownership: reservedRuntime.lifecycle.ownership,
	});
	if (!acknowledged.ok) return current;
	publishCoordinatorSnapshot(store, acknowledged.agent);
	return acknowledged.agent;
}

export function notifyWaitingAgent(
	message: AgentMailboxMessage,
	desktopNotifier: AgentDesktopNotifier,
): DesktopNotificationHandle | undefined {
	if (!isWaitingForInputNotification(message)) {
		return undefined;
	}
	try {
		return toDesktopNotificationHandle(
			desktopNotifier({
				body: message.body ?? `${message.fromAgentId} is waiting for input.`,
				expireTimeMs: PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
				title: "Pi agent needs input",
			}),
		);
	} catch (error) {
		console.error("Failed to send agent input-needed desktop notification:", error);
		return undefined;
	}
}

export function rememberWaitingDesktopNotification(
	store: MultiAgentStore,
	message: AgentMailboxMessage,
	notificationHandle: DesktopNotificationHandle | undefined,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
): void {
	if (!notificationHandle) {
		return;
	}
	closeWaitingDesktopNotification(message.fromAgentId, waitingDesktopNotifications);
	const unsubscribeTransition = store.subscribeAgentTransitions((previous, current) => {
		if (current.id !== message.fromAgentId || previous.lifecycle !== "waiting_for_input") {
			return;
		}
		if (current.lifecycle !== "waiting_for_input") {
			closeWaitingDesktopNotification(current.id, waitingDesktopNotifications);
		}
	});
	waitingDesktopNotifications.set(message.fromAgentId, { handle: notificationHandle, unsubscribeTransition });
}

export function closeWaitingDesktopNotificationWhenNotWaiting(
	store: MultiAgentStore,
	agentId: string,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
): void {
	const current = store.getAgent(agentId);
	if (current?.lifecycle === "waiting_for_input") {
		return;
	}
	closeWaitingDesktopNotification(agentId, waitingDesktopNotifications);
}

export function closeWaitingDesktopNotification(
	agentId: string,
	waitingDesktopNotifications: WaitingDesktopNotificationHandles,
): void {
	const notificationRegistration = waitingDesktopNotifications.get(agentId);
	if (!notificationRegistration) {
		return;
	}
	waitingDesktopNotifications.delete(agentId);
	notificationRegistration.unsubscribeTransition();
	try {
		notificationRegistration.handle.close();
	} catch (error) {
		console.error("Failed to close agent input-needed desktop notification:", error);
	}
}

export function isWaitingForInputNotification(message: AgentMailboxMessage): boolean {
	return (
		message.kind === "system" &&
		message.status === "pending" &&
		(message.threadId?.startsWith("agent-waiting-for-input:") ?? false)
	);
}
