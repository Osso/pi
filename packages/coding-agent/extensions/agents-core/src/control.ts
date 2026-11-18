import type {
	AgentToolResult,
	ExtensionContext,
	ViewedSessionMutationTarget,
} from "../../../src/core/extensions/types.ts";
import {
	type AgentFileReference,
	type AgentMailboxMessage,
	type AgentSnapshot,
	isActiveLifecycle,
	type MultiAgentStore,
	type SteeringCheckpoint,
} from "../../../src/core/multi-agent-store.ts";
import { isProcessIdentityAlive } from "../../../src/core/runtime-process.ts";
import { readMultiAgentRuntimeOwnership } from "../../../src/core/session-control-db.ts";
import { resolveLiveAgentMutationTarget } from "./agent-model-tool.ts";
import type { MultiAgentRuntimeHandles } from "./contracts.ts";
import {
	type AgentSteerToolDetails,
	type AgentToolDetails,
	CANCELLATION_SETTLEMENT_TIMEOUT_MS,
	type CancelAgentParams,
	MAIN_THREAD_AGENT_ID,
	type SteerAgentParams,
} from "./contracts.ts";
import {
	type DetachedRuntimeCancellationOptions,
	readDetachedRuntimeAgentIds,
	requestPersistedDetachedRuntimeCancellation,
} from "./detached-runtime-cancellation.ts";
import { createLifecycleCoordinator } from "./lifecycle-runtime.ts";
import { currentMessageSenderId, emptyAgent, failedMessage, result } from "./messaging.ts";

export function resolveSelectedSessionMutationTarget(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
): ViewedSessionMutationTarget | undefined {
	const selectedAgentId = store.getSelectedAgentId();
	if (!selectedAgentId || selectedAgentId === MAIN_THREAD_AGENT_ID) return undefined;
	return resolveLiveAgentMutationTarget(store, runtimeHandles.sessions, selectedAgentId);
}

export type CancelReservedAgentResult =
	| { ok: true; agent: AgentSnapshot }
	| {
			ok: false;
			error: "agent_not_found" | "runtime_ownership_unavailable" | "mutation_rejected";
			agent?: AgentSnapshot;
	  };

export async function cancelOwnedAgentRuntime(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	agentId: string,
	ownerSessionId: string,
	reason?: string,
): Promise<CancelReservedAgentResult> {
	const descendants = store
		.listDescendants(agentId)
		.filter((agent) => isActiveLifecycle(agent.lifecycle))
		.reverse();
	const detachedRuntimeAgentIds = readDetachedRuntimeAgentIds(
		store,
		descendants.map((agent) => agent.id),
	);
	for (const descendant of descendants) {
		const cancelled = await cancelOneOwnedAgentRuntime(store, runtimeHandles, descendant.id, ownerSessionId, {
			reason,
			suppressTerminalNotification: detachedRuntimeAgentIds.has(descendant.id),
		});
		if (!cancelled.ok) return cancelled;
	}
	return cancelOneOwnedAgentRuntime(store, runtimeHandles, agentId, ownerSessionId, { reason });
}

export function abortAgentHandleSafely(store: MultiAgentStore, agentId: string): void {
	try {
		store.abortAgentHandle(agentId);
	} catch (error) {
		console.error(`Failed to abort agent runtime ${agentId}:`, error);
	}
}

export async function cancelOneOwnedAgentRuntime(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	agentId: string,
	ownerSessionId: string,
	options: DetachedRuntimeCancellationOptions,
): Promise<CancelReservedAgentResult> {
	const current = store.getAgent(agentId);
	if (!current) return { ok: false, error: "agent_not_found" };
	// A finished agent has nothing left to cancel; models often close an agent right after its report.
	if (!isActiveLifecycle(current.lifecycle)) return { ok: true, agent: current };
	const reservedRuntime = runtimeHandles.ownerships.get(agentId);
	if (!reservedRuntime && current.lifecycle === "waiting_for_input") {
		return closeIdleAgentWithoutRuntime(store, current, ownerSessionId);
	}
	if (!reservedRuntime) return requestPersistedDetachedRuntimeCancellation(store, current, options);
	const cancelling = reservedRuntime.coordinator.requestCancellation({
		agent: current,
		ownership: reservedRuntime.lifecycle.ownership,
	});
	if (!cancelling.ok) return { ok: false, error: "mutation_rejected", agent: current };
	store.publishLifecycleCoordinatorSnapshot(cancelling.agent);
	abortAgentHandleSafely(store, agentId);
	const dispatch = runtimeHandles.dispatches.get(agentId);
	if (dispatch) {
		const timeoutMs = runtimeHandles.cancellationSettlementTimeoutMs ?? CANCELLATION_SETTLEMENT_TIMEOUT_MS;
		await Promise.race([
			dispatch.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
		]);
	}
	const settled = store.getAgent(agentId) ?? cancelling.agent;
	return { ok: true, agent: settled };
}

/**
 * An idle agent with no runtime in this process, such as a session attached without a prompt
 * or one parked before a restart, has nothing to abort: take its ownership and record it aborted.
 * A live owner elsewhere keeps the agent.
 */

export function closeIdleAgentWithoutRuntime(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	ownerSessionId: string,
): CancelReservedAgentResult {
	const coordinator = createLifecycleCoordinator(store);
	const acquired = coordinator?.acquireAttachedRuntime(agent, ownerSessionId);
	if (!coordinator || !acquired?.ok) return { ok: false, error: "runtime_ownership_unavailable", agent };
	const aborted = coordinator.acknowledgeCancellation({ agent: acquired.agent, ownership: acquired.ownership });
	if (!aborted.ok) return { ok: false, error: "mutation_rejected", agent };
	store.publishLifecycleCoordinatorSnapshot(aborted.agent);
	return { ok: true, agent: aborted.agent };
}

/** Event other extensions emit to close every running child agent of this session. */
export const CLOSE_ALL_AGENTS_EVENT = "agents:close-all";

/** The agents runtime assigns `closed` during emit; it resolves with the agents still running afterwards. */
export interface CloseAllAgentsRequest {
	ownerSessionId: string;
	reason: string;
	closed?: Promise<AgentSnapshot[]>;
}

/** Active agents with a transcript; detached tool jobs have none. */
export function runningChildAgents(store: MultiAgentStore): AgentSnapshot[] {
	return store.listActiveAgents().filter((agent) => agent.transcript?.path);
}

/** Closes each running child agent with its descendants and waits for its turn to settle. */
export async function closeAllAgents(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	request: CloseAllAgentsRequest,
): Promise<AgentSnapshot[]> {
	for (const agent of runningChildAgents(store)) {
		const current = store.getAgent(agent.id);
		if (!current || !isActiveLifecycle(current.lifecycle)) continue;
		await cancelOwnedAgentRuntime(store, runtimeHandles, agent.id, request.ownerSessionId, request.reason);
	}
	return runningChildAgents(store);
}

export async function cancelAgent(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	params: CancelAgentParams,
	ownerSessionId: string,
): Promise<AgentToolResult<AgentToolDetails>> {
	const cancelled = await cancelOwnedAgentRuntime(
		store,
		runtimeHandles,
		params.agentId,
		ownerSessionId,
		params.reason,
	);
	if (!cancelled.ok) {
		const error =
			cancelled.error === "runtime_ownership_unavailable" ? "runtime ownership unavailable" : cancelled.error;
		return result(`Could not cancel ${params.agentId}: ${error}`, {
			agent: cancelled.agent ?? emptyAgent(params.agentId),
			reason: params.reason,
		});
	}
	return result(describeCancellation(cancelled.agent), { agent: cancelled.agent, reason: params.reason });
}

function describeCancellation(agent: AgentSnapshot): string {
	if (agent.lifecycle === "aborted") return `Cancelled ${agent.displayName}.`;
	if (isActiveLifecycle(agent.lifecycle)) return `Cancellation requested for ${agent.displayName}.`;
	return `${agent.displayName} already ${agent.lifecycle}; nothing to cancel.`;
}

export interface AgentSteeringRuntimeBinding {
	actorAgentId: string | null;
	controlDbPath: string;
	sessionId: string;
}

export interface AgentSteeringRequest {
	agentId: string;
	message: string;
	fileRefs?: AgentFileReference[];
	targetCheckpoint?: SteeringCheckpoint;
}

export type AgentSteeringRequestResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; agent: AgentSnapshot; message: AgentMailboxMessage; error: string };

export function wakeWaitAgentsAfterSteering(runtimeHandles: MultiAgentRuntimeHandles): void {
	for (const listener of runtimeHandles.waitWakeListeners) listener({ kind: "steering" });
}

export function requestInteractiveAgentSteering(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	agentId: string,
	message: string,
	binding: AgentSteeringRuntimeBinding,
): { ok: true } | { error: string; ok: false } {
	const steered = requestAgentSteering(
		store,
		{ agentId, message, targetCheckpoint: "next_model_call" },
		binding,
		runtimeHandles,
	);
	return steered.ok ? { ok: true } : { error: steered.error, ok: false };
}

export function requestAgentSteering(
	store: MultiAgentStore,
	params: AgentSteeringRequest,
	binding: AgentSteeringRuntimeBinding,
	runtimeHandles?: MultiAgentRuntimeHandles,
): AgentSteeringRequestResult {
	const senderId = binding.actorAgentId ?? "supervisor";
	const current = store.getAgent(params.agentId);
	if (!current) {
		return {
			agent: emptyAgent(params.agentId),
			error: `Could not steer ${params.agentId}: not_found`,
			message: failedMessage("supervisor", params.agentId, "steer", params.message),
			ok: false,
		};
	}
	if (!isActiveLifecycle(current.lifecycle)) {
		return {
			agent: current,
			error: `Could not steer ${params.agentId}: inactive (${current.lifecycle})`,
			message: failedMessage("supervisor", params.agentId, "steer", params.message),
			ok: false,
		};
	}

	const persistence = store.getPersistenceTarget();
	const coordinator = createLifecycleCoordinator(store);
	const ownership = persistence
		? readMultiAgentRuntimeOwnership(persistence.controlDbPath, persistence.sessionPath, current.id)
		: undefined;
	const expectedActorId = ownership?.owner.agentId ?? null;
	const targetSessionId = current.transcript?.sessionId;
	if (
		!coordinator ||
		!ownership ||
		!persistence ||
		persistence.controlDbPath !== binding.controlDbPath ||
		binding.actorAgentId !== expectedActorId ||
		binding.sessionId !== ownership.owner.sessionId ||
		!ownership.processIdentity ||
		!isProcessIdentityAlive(ownership.processIdentity) ||
		!targetSessionId
	) {
		return {
			agent: current,
			error: `Could not steer ${params.agentId}: runtime ownership unavailable`,
			message: failedMessage("supervisor", params.agentId, "steer", params.message),
			ok: false,
		};
	}
	const steered = coordinator.requestSteering({
		agent: current,
		body: params.message,
		fileRefs: params.fileRefs,
		fromAgentId: senderId,
		ownership,
		recipient: { agentId: current.id, sessionId: targetSessionId },
		targetCheckpoint: params.targetCheckpoint as SteeringCheckpoint | undefined,
	});
	if (!steered.ok) {
		const error = steered.error === "invalid_transition" ? "inactive" : steered.error;
		return {
			agent: current,
			error: `Could not steer ${params.agentId}: ${error}`,
			message: failedMessage("supervisor", params.agentId, "steer", params.message),
			ok: false,
		};
	}
	store.publishLifecycleCoordinatorSteering(steered.agent, steered.message);
	for (const listener of runtimeHandles?.waitWakeListeners ?? []) {
		listener({ agentId: steered.agent.id, kind: "steering" });
	}
	return { agent: steered.agent, message: steered.message, ok: true };
}

export function steerAgent(
	store: MultiAgentStore,
	runtimeHandles: MultiAgentRuntimeHandles,
	params: SteerAgentParams,
	ctx?: ExtensionContext,
): AgentToolResult<AgentSteerToolDetails> {
	const persistence = store.getPersistenceTarget();
	const controlDbPath = ctx?.controlDbPath ?? persistence?.controlDbPath;
	const senderId = currentSteeringSenderId(store, ctx);
	if (!ctx || !controlDbPath || !senderId) {
		return result("Could not steer agent: subagent runtime identity is unavailable.", {
			agent: emptyAgent(params.agentId),
			message: failedMessage("supervisor", params.agentId, "steer", params.message),
		});
	}
	const steered = requestAgentSteering(
		store,
		params,
		{
			actorAgentId: senderId === "supervisor" ? null : senderId,
			controlDbPath,
			sessionId: ctx.sessionManager?.getSessionId() ?? persistence?.sessionPath ?? "",
		},
		runtimeHandles,
	);
	if (!steered.ok) {
		return result(steered.error, { agent: steered.agent, message: steered.message });
	}
	return result(`Queued steering for ${steered.agent.displayName}.`, {
		agent: steered.agent,
		message: steered.message,
	});
}

export function currentSteeringSenderId(store: MultiAgentStore, ctx: ExtensionContext | undefined): string | undefined {
	const senderId = currentMessageSenderId(store, ctx);
	if (!senderId) {
		return undefined;
	}
	return senderId === MAIN_THREAD_AGENT_ID ? "supervisor" : senderId;
}
