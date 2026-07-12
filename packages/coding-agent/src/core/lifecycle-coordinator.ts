import type { AgentSnapshot, SpawnAgentInput } from "./multi-agent-store.ts";
import {
	commitMultiAgentLifecycleMutation,
	createMultiAgentChildWithDispatchReservation,
	type MultiAgentDispatchLease,
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
	ownerSessionId: string;
}

export type CreateChildCommandResult =
	| { ok: true; agent: AgentSnapshot; reservation: MultiAgentDispatchLease }
	| { ok: false; error: "agent_exists" | "parent_not_found" };

export interface ReservedLifecycleCommandInput {
	agent: AgentSnapshot;
	reservation: MultiAgentDispatchLease;
}

export type ReservedLifecycleCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export class LifecycleCoordinator {
	private readonly options: LifecycleCoordinatorOptions;

	constructor(options: LifecycleCoordinatorOptions) {
		this.options = options;
	}

	beginChildRuntime(input: ReservedLifecycleCommandInput): ReservedLifecycleCommandResult {
		return this.commitReservedLifecycle(input, "starting");
	}

	confirmChildRuntime(input: ReservedLifecycleCommandInput): ReservedLifecycleCommandResult {
		return this.commitReservedLifecycle(input, "running");
	}

	createChild(input: CreateChildCommandInput): CreateChildCommandResult {
		const nowIso = this.options.now();
		const agentId = this.options.createAgentId();
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
		requestedLifecycle: "starting" | "running",
	): ReservedLifecycleCommandResult {
		const reservation = input.reservation;
		if (!reservation.leaseId || !reservation.runtimeIncarnation || !reservation.owner.sessionId) {
			return { ok: false, error: "mutation_mismatch" };
		}
		const updatedAt = this.options.now();
		const result = commitMultiAgentLifecycleMutation(this.options.controlDbPath, {
			agentId: input.agent.id,
			expectedRevision: input.agent.revision,
			fencingEpoch: reservation.fencingEpoch,
			leaseId: reservation.leaseId,
			owner: { agentId: reservation.owner.agentId, sessionId: reservation.owner.sessionId },
			requestedLifecycle,
			runtimeIncarnation: reservation.runtimeIncarnation,
			sessionPath: this.options.sessionPath,
			updatedAt,
		});
		if (!result.ok) return result;
		return {
			ok: true,
			agent: { ...input.agent, lifecycle: requestedLifecycle, revision: input.agent.revision + 1, updatedAt },
		};
	}
}
