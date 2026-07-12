import { randomUUID } from "node:crypto";
import { LifecycleCoordinator } from "../../src/core/lifecycle-coordinator.ts";
import type {
	AgentSnapshot,
	AttachSessionAgentInput,
	MailboxMessageStatus,
	MultiAgentStore,
	SendSteeringInput,
	SpawnAgentInput,
	SpawnChildAgentInput,
	TransitionAgentDetails,
} from "../../src/core/multi-agent-store.ts";
import { readMultiAgentDispatchLease } from "../../src/core/session-control-db.ts";
import { deliverTerminalOutboxProjections } from "../../src/core/terminal-outbox-delivery.ts";

export function legacyMultiAgentStore(store: MultiAgentStore) {
	return {
		ackSteering: (
			agentId: string,
			expectedRevision: number,
			messageId: string,
			status: Exclude<MailboxMessageStatus, "pending">,
		) => {
			const reserved = reservedAgent(store, agentId);
			if (!reserved) return store.ackSteering(agentId, expectedRevision, messageId, status);
			if (status === "accepted") {
				const message = store.listMailboxMessages().find((candidate) => candidate.id === messageId);
				if (!message) return { agentId, error: "message_not_found" as const, ok: false as const };
				const accepted = { ...message, status, updatedAt: new Date().toISOString() };
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
		},
		attachSessionAgent: (parentId: string, input: AttachSessionAgentInput) =>
			store.attachSessionAgent(parentId, input),
		sendSteering: (agentId: string, expectedRevision: number, input: SendSteeringInput) => {
			const reserved = reservedAgent(store, agentId);
			if (!reserved) return store.sendSteering(agentId, expectedRevision, input);
			const message = store.prepareSteeringMessageForLifecycleCoordinator(agentId, input);
			const result = reserved.coordinator.requestSteering({
				agent: reserved.agent,
				message,
				reservation: reserved.reservation,
			});
			if (result.ok) store.publishLifecycleCoordinatorSteering(result.agent, result.message);
			return result;
		},
		spawnAgent: (input: SpawnAgentInput) => store.spawnAgent(input),
		spawnChildAgent: (parentId: string, input: SpawnChildAgentInput) => store.spawnChildAgent(parentId, input),
		transitionAgent: (
			agentId: string,
			expectedRevision: number,
			requested: AgentSnapshot["lifecycle"],
			details: TransitionAgentDetails = {},
		) => transitionReservedAgent(store, agentId, expectedRevision, requested, details),
	};
}

function transitionReservedAgent(
	store: MultiAgentStore,
	agentId: string,
	expectedRevision: number,
	requested: AgentSnapshot["lifecycle"],
	details: TransitionAgentDetails,
) {
	const reserved = reservedAgent(store, agentId);
	if (!reserved) return store.transitionAgent(agentId, expectedRevision, requested, details);
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

function reservedAgent(store: MultiAgentStore, agentId: string) {
	const persistence = store.getPersistenceTarget();
	const agent = store.getAgent(agentId);
	if (!persistence || !agent) return undefined;
	const reservation = readMultiAgentDispatchLease(persistence.controlDbPath, persistence.sessionPath, agentId);
	if (!reservation) return undefined;
	return {
		agent,
		coordinator: new LifecycleCoordinator({
			controlDbPath: persistence.controlDbPath,
			createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
			createLeaseId: randomUUID,
			now: () => new Date().toISOString(),
			reservationDurationMs: 30_000,
			runtimeIncarnation: reservation.runtimeIncarnation ?? "legacy-test-runtime",
			sessionPath: persistence.sessionPath,
		}),
		reservation,
	};
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
