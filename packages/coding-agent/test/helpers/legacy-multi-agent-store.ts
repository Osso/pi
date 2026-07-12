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
	acquireMultiAgentDispatchLease,
	type MultiAgentDispatchLease,
	readMultiAgentDispatchLease,
} from "../../src/core/session-control-db.ts";
import { deliverTerminalOutboxProjections } from "../../src/core/terminal-outbox-delivery.ts";

interface TransitionAgentDetails {
	error?: AgentSnapshot["error"];
	lastActivity?: AgentSnapshot["lastActivity"];
	result?: AgentSnapshot["result"];
}

const terminalStates = new Set<AgentLifecycleState>(["completed", "failed", "aborted"]);
const allowedTransitions: ReadonlyMap<AgentLifecycleState, ReadonlySet<AgentLifecycleState>> = new Map([
	["queued", new Set(["starting", "cancelling", "aborted"])],
	["starting", new Set(["running", "cancelling", "failed", "aborted"])],
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
			store.attachSessionAgent(parentId, input),
		sendSteering: (agentId: string, expectedRevision: number, input: SendSteeringInput) =>
			requestSteering(store, agentId, expectedRevision, input),
		spawnAgent: (input: SpawnAgentInput) => store.spawnAgent(input),
		spawnChildAgent: (parentId: string, input: SpawnChildAgentInput) => store.spawnChildAgent(parentId, input),
		transitionAgent: (
			agentId: string,
			expectedRevision: number,
			requested: AgentSnapshot["lifecycle"],
			details: TransitionAgentDetails = {},
		) => transitionAgent(store, agentId, expectedRevision, requested, details),
	};
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
		reservation: reserved.reservation,
	});
	if (result.ok) store.publishLifecycleCoordinatorSteeringDelivery(result.agent, result.message);
	return result;
}

function requestSteering(store: MultiAgentStore, agentId: string, expectedRevision: number, input: SendSteeringInput) {
	const reserved = reservedAgent(store, agentId);
	if (!reserved) return requestUnreservedSteering(store, agentId, expectedRevision, input);
	const preparedMessage = store.prepareSteeringMessageForLifecycleCoordinator(agentId, input);
	const message =
		reserved.reservation.owner.sessionId === "legacy-test-session"
			? {
					...preparedMessage,
					createdAt: shiftIso(reserved.agent.updatedAt, -1),
					updatedAt: shiftIso(reserved.agent.updatedAt, -1),
				}
			: preparedMessage;
	const result = reserved.coordinator.requestSteering({
		agent: reserved.agent,
		message,
		reservation: reserved.reservation,
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
	const command = { agent: reserved.agent, reservation: reserved.reservation };
	const result =
		requested === "starting"
			? reserved.coordinator.beginChildRuntime(command)
			: requested === "running"
				? reserved.coordinator.confirmChildRuntime(command)
				: requested === "waiting_for_input"
					? reserved.coordinator.markWaitingForInput(command)
					: requested === "cancelling"
						? reserved.coordinator.requestCancellation(command)
						: requested === "completed" || requested === "failed" || requested === "aborted"
							? reserved.coordinator.finalizeChild({
									agent: reserved.agent,
									error: details.error,
									eventPayload: details,
									reservation: reserved.reservation,
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
	reservation: MultiAgentDispatchLease;
}

function reservedAgent(store: MultiAgentStore, agentId: string): ReservedAgent | undefined {
	const persistence = store.getPersistenceTarget();
	const agent = store.getAgent(agentId);
	if (!persistence || !agent) return undefined;
	const existingReservation = readMultiAgentDispatchLease(persistence.controlDbPath, persistence.sessionPath, agentId);
	const reservation =
		existingReservation ?? acquireTestReservation(persistence.controlDbPath, persistence.sessionPath, agent);
	return {
		agent,
		coordinator: new LifecycleCoordinator({
			controlDbPath: persistence.controlDbPath,
			createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
			createLeaseId: randomUUID,
			now: () => reservation.renewedAt ?? shiftIso(agent.updatedAt, -2),
			reservationDurationMs: 1,
			runtimeIncarnation: reservation.runtimeIncarnation ?? "legacy-test-runtime",
			sessionPath: persistence.sessionPath,
		}),
		reservation,
	};
}

function acquireTestReservation(
	controlDbPath: string,
	sessionPath: string,
	agent: AgentSnapshot,
): MultiAgentDispatchLease {
	const result = acquireMultiAgentDispatchLease(controlDbPath, {
		agentId: agent.id,
		expiresAt: agent.updatedAt,
		leaseId: randomUUID(),
		nowIso: shiftIso(agent.updatedAt, -2),
		owner: { agentId: agent.parentId ?? null, sessionId: "legacy-test-session" },
		runtimeIncarnation: "legacy-test-runtime",
		sessionPath,
	});
	if (!result.ok) throw new Error(`Could not acquire test reservation for ${agent.id}: ${result.error}`);
	return result.lease;
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
