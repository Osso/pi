import type { AgentMailboxMessage, AgentSnapshot, SpawnAgentInput } from "./multi-agent-store.ts";
import type { ProcessIdentity } from "./runtime-process.ts";
import {
	acquireAttachedRuntimeLease,
	commitMultiAgentLifecycleMutation,
	commitMultiAgentSteeringDelivery,
	commitMultiAgentSteeringMutation,
	commitMultiAgentTerminalMutation,
	createMultiAgentAttachment,
	createMultiAgentChildWithDispatchReservation,
	type MultiAgentDispatchLease,
	readMultiAgentAgent,
	recoverDeadMultiAgentRuntime,
} from "./session-control-db.ts";

const MAIN_THREAD_AGENT_ID = "main";

export interface LifecycleCoordinatorOptions {
	controlDbPath: string;
	createAgentId: () => string;
	now: () => string;
	processIdentity: ProcessIdentity;
	sessionPath: string;
}

export interface CreateChildCommandInput extends SpawnAgentInput {
	agentId?: string;
	ownerSessionId: string;
	processIdentity?: ProcessIdentity;
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

export interface RecoverDeadChildCommandInput extends ReservedLifecycleCommandInput {
	ownerSessionId: string;
}

export type RecoverDeadChildCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| {
			ok: false;
			error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" | "owner_alive";
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
			nowIso,
			owner: { agentId: null, sessionId: ownerSessionId },
			processIdentity: this.options.processIdentity,
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
			messageId: input.messageId,
			owner: identity.owner,
			requestedLifecycle: "running",
			processIdentity: identity.processIdentity,
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
			message: input.message,
			owner: identity.owner,
			requestedLifecycle: "steering_pending",
			processIdentity: identity.processIdentity,
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

	recoverDeadChild(input: RecoverDeadChildCommandInput): RecoverDeadChildCommandResult {
		const identity = this.readReservationIdentity(input.reservation);
		if (
			!identity ||
			identity.agentId !== input.agent.id ||
			identity.sessionPath !== this.options.sessionPath ||
			identity.owner.sessionId !== input.ownerSessionId
		) {
			return { ok: false, error: "mutation_mismatch" };
		}
		const nowIso = this.options.now();
		const recovered = recoverDeadMultiAgentRuntime(this.options.controlDbPath, {
			expectedOwner: identity,
			nowIso,
		});
		if (!recovered.ok) return recovered;
		return { ok: true, agent: recovered.agent as unknown as AgentSnapshot };
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
			owner: identity.owner,
			processIdentity: identity.processIdentity,
			sessionPath: this.options.sessionPath,
			terminalLifecycle: input.terminalLifecycle,
			updatedAt,
		});
		if (!result.ok) return result;
		const committed = readMultiAgentAgent(this.options.controlDbPath, this.options.sessionPath, input.agent.id);
		if (!committed) return { ok: false, error: "agent_not_found" };
		return { ok: true, agent: committed };
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
			nowIso,
			owner: { agentId: null, sessionId: input.ownerSessionId },
			processIdentity: input.processIdentity ?? this.options.processIdentity,
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
			owner: identity.owner,
			requestedLifecycle,
			processIdentity: identity.processIdentity,
			sessionPath: this.options.sessionPath,
			updatedAt,
		});
		if (!result.ok) return result;
		return { ok: true, agent: result.agent as unknown as AgentSnapshot };
	}

	private readReservationIdentity(reservation: MultiAgentDispatchLease):
		| {
				agentId: string;
				owner: { agentId: string | null; sessionId: string };
				processIdentity: ProcessIdentity;
				sessionPath: string;
		  }
		| undefined {
		if (!reservation.processIdentity || !reservation.owner.sessionId) return undefined;
		return {
			agentId: reservation.agentId,
			owner: { agentId: reservation.owner.agentId, sessionId: reservation.owner.sessionId },
			processIdentity: reservation.processIdentity,
			sessionPath: reservation.sessionPath,
		};
	}
}
