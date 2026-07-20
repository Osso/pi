import { randomUUID } from "node:crypto";
import { LifecycleCoordinator } from "../../src/core/lifecycle-coordinator.ts";
import type {
	AgentLifecycleState,
	AgentSnapshot,
	AttachSessionAgentInput,
	MailboxMessageStatus,
	MultiAgentStore,
	SendSteeringInput,
	SpawnAgentInput,
	SpawnChildAgentInput,
} from "../../src/core/multi-agent-store.ts";
import {
	bootstrapMultiAgentAgent,
	type MultiAgentRuntimeOwnership,
	readMultiAgentRuntimeOwnership,
	registerRuntimeMailboxListener,
} from "../../src/core/session-control-db.ts";
import { deliverTerminalOutboxProjections } from "../../src/core/terminal-outbox-delivery.ts";
import { testProcessIdentity } from "./process-identity.ts";
import { forceRuntimeOwnership } from "./runtime-ownership.ts";

interface TransitionAgentDetails {
	error?: AgentSnapshot["error"];
	lastActivity?: AgentSnapshot["lastActivity"];
	result?: AgentSnapshot["result"];
}

const terminalStates = new Set<AgentLifecycleState>(["completed", "failed", "aborted"]);
const allowedTransitions: ReadonlyMap<AgentLifecycleState, ReadonlySet<AgentLifecycleState>> = new Map([
	["running", new Set(["waiting_for_input", "steering_pending", "cancelling", "completed", "failed", "aborted"])],
	["waiting_for_input", new Set(["running", "steering_pending", "cancelling", "completed", "aborted"])],
	["steering_pending", new Set(["running", "waiting_for_input", "cancelling", "failed", "aborted"])],
	["cancelling", new Set(["aborted", "failed", "completed"])],
	["completed", new Set()],
	["failed", new Set()],
	["aborted", new Set()],
]);

export function legacyMultiAgentStore(store: MultiAgentStore) {
	return {
		ackSteering: (
			agentId: string,
			expectedRevision: number,
			messageId: string,
			status: Exclude<MailboxMessageStatus, "pending">,
		) => acknowledgeSteering(store, agentId, expectedRevision, messageId, status),
		attachSessionAgent: (parentId: string, input: AttachSessionAgentInput) =>
			attachTestSessionAgent(store, parentId, input),
		sendSteering: (agentId: string, expectedRevision: number, input: SendSteeringInput) =>
			requestSteering(store, agentId, expectedRevision, input),
		spawnAgent: (input: SpawnAgentInput) => spawnTestAgent(store, input),
		spawnChildAgent: (parentId: string, input: SpawnChildAgentInput) => spawnTestChildAgent(store, parentId, input),
		transitionAgent: (
			agentId: string,
			expectedRevision: number,
			requested: AgentSnapshot["lifecycle"],
			details: TransitionAgentDetails = {},
		) => transitionAgent(store, agentId, expectedRevision, requested, details),
	};
}

function spawnTestAgent(store: MultiAgentStore, input: SpawnAgentInput): { agent: AgentSnapshot } {
	const timestamp = new Date().toISOString();
	const agent: AgentSnapshot = {
		account: input.account
			? {
					budgetId: input.account.budgetId,
					concurrencyCap: input.account.concurrencyCap,
					id: input.account.id,
					providerFallback: input.account.providerFallback ? [...input.account.providerFallback] : undefined,
					rateLimit: input.account.rateLimit ? { ...input.account.rateLimit } : undefined,
					tokenBudget: input.account.tokenBudget ? { ...input.account.tokenBudget } : undefined,
				}
			: undefined,
		agentType: input.agentType,
		createdAt: timestamp,
		cwd: input.cwd,
		displayName: input.displayName,
		eventStream: input.eventStream,
		id: store.allocateAgentIdForLifecycleCoordinator(),
		lifecycle: "running",
		model: input.model,
		origin: input.origin,
		parentId: input.parentId,
		permission: { ...input.permission },
		revision: 1,
		slot: input.slot,
		transcript: input.transcript,
		updatedAt: timestamp,
		worker: input.worker,
		worktree: input.worktree,
	};
	const persistence = store.getPersistenceTarget();
	if (persistence) {
		bootstrapMultiAgentAgent(persistence.controlDbPath, persistence.sessionPath, agent.id, agent);
	}
	store.publishLifecycleCoordinatorSnapshot(agent);
	return { agent };
}

function spawnTestChildAgent(store: MultiAgentStore, parentId: string, input: SpawnChildAgentInput) {
	const parent = store.getAgent(parentId);
	if (!parent) return { error: "parent_not_found" as const, ok: false as const, parentId };
	if (!input.permission.narrowed || input.permission.policy !== parent.permission.policy) {
		return {
			error: "permission_broadened" as const,
			ok: false as const,
			parent,
			requested: input.permission,
		};
	}
	const spawned = spawnTestAgent(store, {
		...input,
		account: input.account ?? parent.account,
		model: input.model ?? parent.model,
		parentId,
	});
	return { agent: spawned.agent, ok: true as const };
}

function attachTestSessionAgent(store: MultiAgentStore, parentId: string, input: AttachSessionAgentInput) {
	return spawnTestChildAgent(store, parentId, {
		...input,
		agentType: input.agentType || "resumed-session",
		origin: "attached",
	});
}

function acknowledgeSteering(
	store: MultiAgentStore,
	agentId: string,
	expectedRevision: number,
	messageId: string,
	status: Exclude<MailboxMessageStatus, "pending">,
) {
	const reserved = reservedAgent(store, agentId);
	if (!reserved) return acknowledgeUnreservedSteering(store, agentId, expectedRevision, messageId, status);
	if (status === "accepted") {
		const message = store.listMailboxMessages().find((candidate) => candidate.id === messageId);
		if (!message) return { agentId, error: "message_not_found" as const, ok: false as const };
		const accepted = { ...message, status, updatedAt: reserved.agent.updatedAt };
		store.publishLifecycleCoordinatorSteering(reserved.agent, accepted);
		return { agent: reserved.agent, message: accepted, ok: true as const };
	}
	const result = reserved.coordinator.acknowledgeSteeringDelivery({
		agent: reserved.agent,
		messageId,
		ownership: reserved.ownership,
	});
	if (result.ok) store.publishLifecycleCoordinatorSteeringDelivery(result.agent, result.message);
	return result;
}

function requestSteering(store: MultiAgentStore, agentId: string, expectedRevision: number, input: SendSteeringInput) {
	const reserved = reservedAgent(store, agentId);
	if (!reserved) return requestUnreservedSteering(store, agentId, expectedRevision, input);
	const ownerSessionId = reserved.ownership.owner.sessionId ?? "legacy-test-session";
	const processIdentity = reserved.ownership.processIdentity ?? testProcessIdentity("legacy-test-runtime");
	registerRuntimeMailboxListener(
		reserved.coordinatorOptions.controlDbPath,
		{ agentId: reserved.ownership.owner.agentId, sessionId: ownerSessionId },
		process.pid,
		reserved.coordinatorOptions.sessionPath,
	);
	const recipientSessionId = reserved.agent.transcript?.sessionId ?? ownerSessionId;
	registerRuntimeMailboxListener(
		reserved.coordinatorOptions.controlDbPath,
		{ agentId: reserved.agent.id, sessionId: recipientSessionId },
		processIdentity.pid,
		undefined,
		{ runtimeInstanceId: JSON.stringify(processIdentity) },
	);
	const result = reserved.coordinator.requestSteering({
		agent: reserved.agent,
		...input,
		fromAgentId: input.fromAgentId === "main" ? "supervisor" : input.fromAgentId,
		ownership: reserved.ownership,
		recipient: {
			agentId: reserved.agent.id,
			sessionId: recipientSessionId,
		},
	});
	if (result.ok) store.publishLifecycleCoordinatorSteering(result.agent, result.message);
	return result;
}

function transitionAgent(
	store: MultiAgentStore,
	agentId: string,
	expectedRevision: number,
	requested: AgentSnapshot["lifecycle"],
	details: TransitionAgentDetails,
) {
	const reserved = reservedAgent(store, agentId);
	return reserved
		? transitionReservedAgent(store, reserved, expectedRevision, requested, details)
		: transitionUnreservedAgent(store, agentId, expectedRevision, requested, details);
}

function transitionReservedAgent(
	store: MultiAgentStore,
	reserved: ReservedAgent,
	expectedRevision: number,
	requested: AgentSnapshot["lifecycle"],
	details: TransitionAgentDetails,
) {
	if (reserved.agent.revision !== expectedRevision) {
		return { current: reserved.agent, error: "stale_revision" as const, ok: false as const };
	}
	const command = { agent: reserved.agent, ownership: reserved.ownership };
	const result =
		requested === "running"
			? reserved.coordinator.confirmChildRuntime(command)
			: requested === "waiting_for_input"
				? reserved.coordinator.markWaitingForInput(command)
				: requested === "cancelling"
					? reserved.coordinator.requestCancellation(command)
					: requested === "completed" || requested === "failed" || requested === "aborted"
						? reserved.coordinator.finalizeChild({
								agent: reserved.agent,
								error: details.error,
								ownership: reserved.ownership,
								result: details.result,
								terminalLifecycle: requested,
							})
						: { error: "invalid_transition" as const, ok: false as const };
	if (!result.ok) return result;
	if (requested === "completed" || requested === "failed" || requested === "aborted") {
		deliverTerminalProjection(store);
	} else {
		store.publishLifecycleCoordinatorSnapshot(result.agent);
	}
	return result;
}

function transitionUnreservedAgent(
	store: MultiAgentStore,
	agentId: string,
	expectedRevision: number,
	requested: AgentSnapshot["lifecycle"],
	details: TransitionAgentDetails,
) {
	const current = store.getAgent(agentId);
	if (!current) return { agentId, error: "not_found" as const, ok: false as const };
	if (current.revision !== expectedRevision) {
		return { current, error: "stale_revision" as const, ok: false as const };
	}
	if (!canTransition(current.lifecycle, requested)) {
		return { current, error: "invalid_transition" as const, ok: false as const, requested };
	}
	const updated = {
		...current,
		...details,
		lifecycle: requested,
		result: details.result ?? current.result,
		revision: current.revision + 1,
		updatedAt: current.updatedAt,
	};
	if (terminalStates.has(requested)) store.publishTerminalOutboxSnapshot(updated);
	else store.publishLifecycleCoordinatorSnapshot(updated);
	return { agent: updated, ok: true as const };
}

function requestUnreservedSteering(
	store: MultiAgentStore,
	agentId: string,
	expectedRevision: number,
	input: SendSteeringInput,
) {
	const current = store.getAgent(agentId);
	if (!current) return { agentId, error: "not_found" as const, ok: false as const };
	if (current.revision !== expectedRevision) {
		return { current, error: "stale_revision" as const, ok: false as const };
	}
	if (!canTransition(current.lifecycle, "steering_pending")) {
		return {
			current,
			error: "invalid_transition" as const,
			ok: false as const,
			requested: "steering_pending" as const,
		};
	}
	const message = store.prepareSteeringMessageForLifecycleCoordinator(agentId, input);
	const updated = {
		...current,
		lifecycle: "steering_pending" as const,
		revision: current.revision + 1,
		updatedAt: current.updatedAt,
	};
	store.publishLifecycleCoordinatorSteering(updated, message);
	return { agent: updated, message, ok: true as const };
}

function acknowledgeUnreservedSteering(
	store: MultiAgentStore,
	agentId: string,
	expectedRevision: number,
	messageId: string,
	status: Exclude<MailboxMessageStatus, "pending">,
) {
	const current = store.getAgent(agentId);
	if (!current) return { agentId, error: "not_found" as const, ok: false as const };
	if (current.revision !== expectedRevision) {
		return { current, error: "stale_revision" as const, ok: false as const };
	}
	const message = store.listMailboxMessages().find((candidate) => candidate.id === messageId);
	if (!message || message.toAgentId !== agentId || message.kind !== "steer") {
		return { agent: current, error: "message_not_found" as const, messageId, ok: false as const };
	}
	const lifecycle = status === "delivered" ? ("running" as const) : current.lifecycle;
	if (lifecycle !== current.lifecycle && !canTransition(current.lifecycle, lifecycle)) {
		return { current, error: "invalid_transition" as const, ok: false as const, requested: lifecycle };
	}
	const updated = { ...current, lifecycle, revision: current.revision + 1, updatedAt: current.updatedAt };
	const updatedMessage = { ...message, status, updatedAt: message.updatedAt };
	store.publishLifecycleCoordinatorSteeringDelivery(updated, updatedMessage);
	return { agent: updated, message: updatedMessage, ok: true as const };
}

function canTransition(from: AgentLifecycleState, to: AgentLifecycleState): boolean {
	return (from === to && !terminalStates.has(from)) || (allowedTransitions.get(from)?.has(to) ?? false);
}

interface ReservedAgent {
	agent: AgentSnapshot;
	coordinator: LifecycleCoordinator;
	coordinatorOptions: { controlDbPath: string; sessionPath: string };
	ownership: MultiAgentRuntimeOwnership;
}

function reservedAgent(store: MultiAgentStore, agentId: string): ReservedAgent | undefined {
	const persistence = store.getPersistenceTarget();
	const agent = store.getAgent(agentId);
	if (!persistence || !agent) return undefined;
	const existingOwnership = readMultiAgentRuntimeOwnership(
		persistence.controlDbPath,
		persistence.sessionPath,
		agentId,
	);
	const ownership =
		existingOwnership ?? acquireTestOwnership(persistence.controlDbPath, persistence.sessionPath, agent);
	return {
		agent,
		coordinator: new LifecycleCoordinator({
			controlDbPath: persistence.controlDbPath,
			createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
			now: () => shiftIso(agent.updatedAt, -2),
			processIdentity: ownership.processIdentity ?? testProcessIdentity("legacy-test-runtime"),
			sessionPath: persistence.sessionPath,
		}),
		coordinatorOptions: { controlDbPath: persistence.controlDbPath, sessionPath: persistence.sessionPath },
		ownership,
	};
}

function acquireTestOwnership(
	controlDbPath: string,
	sessionPath: string,
	agent: AgentSnapshot,
): MultiAgentRuntimeOwnership {
	const ownerAgentId = agent.parentId === "main" ? null : agent.parentId;
	const result = forceRuntimeOwnership(controlDbPath, {
		agentId: agent.id,
		nowIso: shiftIso(agent.updatedAt, -2),
		owner: { agentId: ownerAgentId ?? null, sessionId: "legacy-test-session" },
		processIdentity: testProcessIdentity("legacy-test-runtime"),
		sessionPath,
	});
	if (!result.ok) throw new Error(`Could not acquire test ownership for ${agent.id}: ${result.error}`);
	return result.ownership;
}

function shiftIso(iso: string, milliseconds: number): string {
	return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function deliverTerminalProjection(store: MultiAgentStore): void {
	const persistence = store.getPersistenceTarget();
	if (!persistence) return;
	deliverTerminalOutboxProjections({
		claimId: randomUUID(),
		controlDbPath: persistence.controlDbPath,
		now: () => new Date().toISOString(),
		store,
	});
}
