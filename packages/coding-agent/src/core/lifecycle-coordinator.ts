import type { AgentMailboxMessage, AgentSnapshot, SpawnAgentInput } from "./multi-agent-store.ts";
import {
	acquireAttachedRuntimeLease,
	acquireMultiAgentRecoveryLeaderLease,
	commitMultiAgentLifecycleMutation,
	commitMultiAgentSteeringDelivery,
	commitMultiAgentSteeringMutation,
	commitMultiAgentTerminalMutation,
	createMultiAgentAttachment,
	createMultiAgentChildWithDispatchReservation,
	type MultiAgentDispatchLease,
	recoverExpiredMultiAgentRuntime,
	releaseMultiAgentRecoveryLeaderLease,
	renewMultiAgentDispatchLease,
} from "./session-control-db.ts";

const MAIN_THREAD_AGENT_ID = "main";

export interface LifecycleCoordinatorOptions {
	controlDbPath: string;
	createAgentId: () => string;
	createLeaseId: () => string;
	now: () => string;
	reservationDurationMs: number;
	runtimeIncarnation: string;
	sessionPath: string;
}

export interface CreateChildCommandInput extends SpawnAgentInput {
	agentId?: string;
	ownerSessionId: string;
	result?: AgentSnapshot["result"];
}

export type CreateChildCommandResult =
	| { ok: true; agent: AgentSnapshot; reservation: MultiAgentDispatchLease }
	| { ok: false; error: "agent_exists" | "parent_not_found" };

export type CreateAttachmentCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_exists" | "parent_not_found" | "permission_broadened" };

export type AcquireAttachedRuntimeCommandResult =
	| { ok: true; agent: AgentSnapshot; reservation: MultiAgentDispatchLease }
	| { ok: false; error: "agent_not_found" | "invalid_agent" | "lease_held" | "mutation_mismatch" };

export interface ReservedLifecycleCommandInput {
	agent: AgentSnapshot;
	reservation: MultiAgentDispatchLease;
}

export interface SteeringDeliveryCommandInput extends ReservedLifecycleCommandInput {
	messageId: string;
}

export interface SteeringCommandInput extends ReservedLifecycleCommandInput {
	message: AgentMailboxMessage;
}

export type SteeringCommandResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "message_not_found" | "mutation_mismatch" };

export interface DetachedCancellationCommandInput extends ReservedLifecycleCommandInput {
	outputLabel: string;
	reason?: string;
}

export type ReservedLifecycleCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export type RenewReservationCommandResult =
	| { ok: true; reservation: MultiAgentDispatchLease }
	| { ok: false; error: "mutation_mismatch" };

export interface RecoverExpiredChildCommandInput {
	agent: AgentSnapshot;
	ownerSessionId: string;
}

export type RecoverExpiredChildCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| {
			ok: false;
			error:
				| "agent_not_found"
				| "invalid_transition"
				| "lease_held"
				| "lease_not_expired"
				| "mutation_mismatch"
				| "not_recovery_leader";
	  };

export interface FinalizeChildCommandInput extends ReservedLifecycleCommandInput {
	error?: AgentSnapshot["error"];
	eventPayload: unknown;
	result?: AgentSnapshot["result"];
	terminalLifecycle: "completed" | "failed" | "aborted";
}

export class LifecycleCoordinator {
	private readonly options: LifecycleCoordinatorOptions;

	constructor(options: LifecycleCoordinatorOptions) {
		this.options = options;
	}

	createAttachment(input: SpawnAgentInput): CreateAttachmentCommandResult {
		const nowIso = this.options.now();
		const agent: AgentSnapshot = {
			...input,
			account: input.account ? { ...input.account } : undefined,
			createdAt: nowIso,
			id: this.options.createAgentId(),
			lifecycle: "waiting_for_input",
			origin: "attached",
			parentId: input.parentId,
			permission: { ...input.permission },
			revision: 1,
			updatedAt: nowIso,
		};
		return createMultiAgentAttachment(this.options.controlDbPath, {
			agent,
			agentId: agent.id,
			nowIso,
			sessionPath: this.options.sessionPath,
		});
	}

	acquireAttachedRuntime(agent: AgentSnapshot, ownerSessionId: string): AcquireAttachedRuntimeCommandResult {
		const nowIso = this.options.now();
		const result = acquireAttachedRuntimeLease(this.options.controlDbPath, {
			agentId: agent.id,
			expectedRevision: agent.revision,
			expiresAt: new Date(Date.parse(nowIso) + this.options.reservationDurationMs).toISOString(),
			leaseId: this.options.createLeaseId(),
			nowIso,
			owner: { agentId: null, sessionId: ownerSessionId },
			runtimeIncarnation: this.options.runtimeIncarnation,
			sessionPath: this.options.sessionPath,
		});
		if (!result.ok) return result;
		return { agent: result.agent, ok: true, reservation: result.lease };
	}

	beginChildRuntime(input: ReservedLifecycleCommandInput): ReservedLifecycleCommandResult {
		return this.commitReservedLifecycle(input, "starting");
	}

	confirmChildRuntime(input: ReservedLifecycleCommandInput): ReservedLifecycleCommandResult {
		return this.commitReservedLifecycle(input, "running");
	}

	acknowledgeSteeringDelivery(input: SteeringDeliveryCommandInput): SteeringCommandResult {
		const identity = this.readReservationIdentity(input.reservation);
		if (!identity) return { ok: false, error: "mutation_mismatch" };
		const result = commitMultiAgentSteeringDelivery(this.options.controlDbPath, {
			agentId: input.agent.id,
			expectedRevision: input.agent.revision,
			fencingEpoch: input.reservation.fencingEpoch,
			leaseId: identity.leaseId,
			messageId: input.messageId,
			owner: identity.owner,
			requestedLifecycle: "running",
			runtimeIncarnation: identity.runtimeIncarnation,
			sessionPath: this.options.sessionPath,
			updatedAt: this.options.now(),
		});
		return result;
	}

	requestSteering(input: SteeringCommandInput): SteeringCommandResult {
		const identity = this.readReservationIdentity(input.reservation);
		if (!identity) return { ok: false, error: "mutation_mismatch" };
		const result = commitMultiAgentSteeringMutation(this.options.controlDbPath, {
			agentId: input.agent.id,
			expectedRevision: input.agent.revision,
			fencingEpoch: input.reservation.fencingEpoch,
			leaseId: identity.leaseId,
			message: input.message,
			owner: identity.owner,
			requestedLifecycle: "steering_pending",
			runtimeIncarnation: identity.runtimeIncarnation,
			sessionPath: this.options.sessionPath,
			updatedAt: input.message.updatedAt,
		});
		return result;
	}

	markWaitingForInput(input: ReservedLifecycleCommandInput): ReservedLifecycleCommandResult {
		return this.commitReservedLifecycle(input, "waiting_for_input");
	}

	requestCancellation(input: ReservedLifecycleCommandInput): ReservedLifecycleCommandResult {
		return this.commitReservedLifecycle(input, "cancelling");
	}

	renewReservation(input: ReservedLifecycleCommandInput): RenewReservationCommandResult {
		const identity = this.readReservationIdentity(input.reservation);
		if (!identity) return { ok: false, error: "mutation_mismatch" };
		const nowIso = this.options.now();
		const result = renewMultiAgentDispatchLease(this.options.controlDbPath, {
			agentId: input.agent.id,
			expectedFencingEpoch: input.reservation.fencingEpoch,
			expiresAt: new Date(Date.parse(nowIso) + this.options.reservationDurationMs).toISOString(),
			leaseId: identity.leaseId,
			nowIso,
			owner: identity.owner,
			runtimeIncarnation: identity.runtimeIncarnation,
			sessionPath: this.options.sessionPath,
		});
		if (!result.ok) return { ok: false, error: "mutation_mismatch" };
		return { ok: true, reservation: result.lease };
	}

	requestDetachedCancellation(input: DetachedCancellationCommandInput): ReservedLifecycleCommandResult {
		return this.commitReservedLifecycle(input, "cancelling", {
			outputLabel: input.outputLabel,
			reason: input.reason,
		});
	}

	acknowledgeCancellation(input: ReservedLifecycleCommandInput & { reason?: string }): ReservedLifecycleCommandResult {
		return this.finalizeChild({
			agent: input.agent,
			eventPayload: { reason: input.reason },
			reservation: input.reservation,
			terminalLifecycle: "aborted",
		});
	}

	recoverExpiredChild(input: RecoverExpiredChildCommandInput): RecoverExpiredChildCommandResult {
		const nowIso = this.options.now();
		const leaderLeaseId = this.options.createLeaseId();
		const leader = acquireMultiAgentRecoveryLeaderLease(this.options.controlDbPath, {
			expiresAt: new Date(Date.parse(nowIso) + this.options.reservationDurationMs).toISOString(),
			leaseId: leaderLeaseId,
			nowIso,
			ownerSessionId: input.ownerSessionId,
			runtimeIncarnation: this.options.runtimeIncarnation,
		});
		if (!leader.ok) return { ok: false, error: "lease_held" };
		const recovered = recoverExpiredMultiAgentRuntime(this.options.controlDbPath, {
			agentId: input.agent.id,
			expectedRevision: input.agent.revision,
			nowIso,
			recoveryLeader: {
				fencingEpoch: leader.lease.fencingEpoch,
				leaseId: leaderLeaseId,
				ownerSessionId: input.ownerSessionId,
				runtimeIncarnation: this.options.runtimeIncarnation,
			},
			replacementLease: {
				agentId: input.agent.id,
				leaseId: this.options.createLeaseId(),
				owner: { agentId: null, sessionId: input.ownerSessionId },
				runtimeIncarnation: this.options.runtimeIncarnation,
				sessionPath: this.options.sessionPath,
			},
			sessionPath: this.options.sessionPath,
		});
		releaseMultiAgentRecoveryLeaderLease(this.options.controlDbPath, {
			expectedFencingEpoch: leader.lease.fencingEpoch,
			leaseId: leaderLeaseId,
			ownerSessionId: input.ownerSessionId,
			runtimeIncarnation: this.options.runtimeIncarnation,
		});
		if (!recovered.ok) return recovered;
		return {
			ok: true,
			agent: {
				...input.agent,
				error: {
					code: "lost_runtime",
					message: "Agent runtime ownership expired before terminal confirmation.",
				},
				lifecycle: "failed",
				revision: recovered.terminalRevision,
				updatedAt: nowIso,
				worker: undefined,
			},
		};
	}

	finalizeChild(input: FinalizeChildCommandInput): ReservedLifecycleCommandResult {
		const identity = this.readReservationIdentity(input.reservation);
		if (!identity) return { ok: false, error: "mutation_mismatch" };
		const updatedAt = this.options.now();
		const result = commitMultiAgentTerminalMutation(this.options.controlDbPath, {
			agentDetails: { error: input.error, result: input.result },
			agentId: input.agent.id,
			eventKind: input.terminalLifecycle,
			eventPayload: input.eventPayload,
			expectedRevision: input.agent.revision,
			fencingEpoch: input.reservation.fencingEpoch,
			leaseId: identity.leaseId,
			owner: identity.owner,
			runtimeIncarnation: identity.runtimeIncarnation,
			sessionPath: this.options.sessionPath,
			terminalLifecycle: input.terminalLifecycle,
			updatedAt,
		});
		if (!result.ok) return result;
		return {
			ok: true,
			agent: {
				...input.agent,
				error: input.error,
				lifecycle: input.terminalLifecycle,
				result: input.result,
				revision: result.terminalRevision,
				updatedAt,
			},
		};
	}

	createChild(input: CreateChildCommandInput): CreateChildCommandResult {
		const nowIso = this.options.now();
		const agentId = input.agentId ?? this.options.createAgentId();
		const parentId = input.parentId ?? MAIN_THREAD_AGENT_ID;
		const agent: AgentSnapshot = {
			account: input.account,
			agentType: input.agentType,
			createdAt: nowIso,
			cwd: input.cwd,
			displayName: input.displayName,
			eventStream: input.eventStream,
			id: agentId,
			lifecycle: "queued",
			model: input.model,
			origin: input.origin,
			parentId,
			permission: { ...input.permission },
			result: input.result,
			revision: 1,
			slot: input.slot,
			transcript: input.transcript,
			updatedAt: nowIso,
			worker: input.worker,
			worktree: input.worktree,
		};
		const result = createMultiAgentChildWithDispatchReservation(this.options.controlDbPath, {
			agent,
			agentId,
			expiresAt: new Date(Date.parse(nowIso) + this.options.reservationDurationMs).toISOString(),
			leaseId: this.options.createLeaseId(),
			nowIso,
			owner: { agentId: null, sessionId: input.ownerSessionId },
			runtimeIncarnation: this.options.runtimeIncarnation,
			sessionPath: this.options.sessionPath,
		});
		if (!result.ok) return result;
		return { ok: true, agent, reservation: result.lease };
	}

	private commitReservedLifecycle(
		input: ReservedLifecycleCommandInput,
		requestedLifecycle: "starting" | "running" | "waiting_for_input" | "cancelling",
		detachedCancellation?: { outputLabel: string; reason?: string },
	): ReservedLifecycleCommandResult {
		const reservation = input.reservation;
		const identity = this.readReservationIdentity(reservation);
		if (!identity) return { ok: false, error: "mutation_mismatch" };
		const updatedAt = this.options.now();
		const result = commitMultiAgentLifecycleMutation(this.options.controlDbPath, {
			agentId: input.agent.id,
			detachedCancellation,
			expectedRevision: input.agent.revision,
			fencingEpoch: reservation.fencingEpoch,
			leaseId: identity.leaseId,
			owner: identity.owner,
			requestedLifecycle,
			runtimeIncarnation: identity.runtimeIncarnation,
			sessionPath: this.options.sessionPath,
			updatedAt,
		});
		if (!result.ok) return result;
		return {
			ok: true,
			agent: { ...input.agent, lifecycle: requestedLifecycle, revision: input.agent.revision + 1, updatedAt },
		};
	}

	private readReservationIdentity(reservation: MultiAgentDispatchLease):
		| {
				leaseId: string;
				owner: { agentId: string | null; sessionId: string };
				runtimeIncarnation: string;
		  }
		| undefined {
		if (!reservation.leaseId || !reservation.runtimeIncarnation || !reservation.owner.sessionId) return undefined;
		return {
			leaseId: reservation.leaseId,
			owner: { agentId: reservation.owner.agentId, sessionId: reservation.owner.sessionId },
			runtimeIncarnation: reservation.runtimeIncarnation,
		};
	}
}
