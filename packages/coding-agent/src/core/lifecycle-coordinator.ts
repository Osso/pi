import type { AgentMailboxMessage, AgentSnapshot, SendSteeringInput, SpawnAgentInput } from "./multi-agent-store.ts";
import type { ProcessIdentity } from "./runtime-process.ts";
import {
	acquireAttachedRuntimeOwnership,
	commitMultiAgentDetachMark,
	commitMultiAgentLifecycleMutation,
	commitMultiAgentSteeringDelivery,
	commitMultiAgentSteeringMutation,
	commitMultiAgentTerminalMutation,
	createFailedMultiAgentChild,
	createMultiAgentAttachment,
	createMultiAgentChildWithRuntimeOwnership,
	type MultiAgentRuntimeOwnership,
	type RuntimeMailboxAddress,
	readMultiAgentAgent,
	reconcileDeadDetachedAgentRuntimes as reconcileDeadDetachedAgentRuntimesRepository,
	recoverDeadMultiAgentRuntime,
} from "./session-control-db.ts";
import { isSqliteContentionError } from "./sqlite.ts";

const MAIN_THREAD_AGENT_ID = "main";
const DEAD_DETACHED_RECONCILIATION_RETRY_DELAY_MS = 250;
const deadDetachedReconciliationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleDeadDetachedReconciliationRetry(controlDbPath: string): void {
	if (deadDetachedReconciliationRetryTimers.has(controlDbPath)) return;
	const timer = setTimeout(() => {
		deadDetachedReconciliationRetryTimers.delete(controlDbPath);
		LifecycleCoordinator.reconcileDeadDetachedRuntimes(controlDbPath, new Date().toISOString());
	}, DEAD_DETACHED_RECONCILIATION_RETRY_DELAY_MS);
	timer.unref();
	deadDetachedReconciliationRetryTimers.set(controlDbPath, timer);
}

function clearDeadDetachedReconciliationRetry(controlDbPath: string): void {
	const timer = deadDetachedReconciliationRetryTimers.get(controlDbPath);
	if (!timer) return;
	clearTimeout(timer);
	deadDetachedReconciliationRetryTimers.delete(controlDbPath);
}

export interface LifecycleCoordinatorOptions {
	controlDbPath: string;
	createAgentId: () => string;
	now: () => string;
	processIdentity: ProcessIdentity;
	sessionPath: string;
}

export interface PrepareChildCommandInput extends SpawnAgentInput {
	agentId?: string;
	detached?: boolean;
	result?: AgentSnapshot["result"];
}

export type CreateChildCommandResult =
	| { ok: true; agent: AgentSnapshot; ownership: MultiAgentRuntimeOwnership }
	| { ok: false; error: "agent_exists" | "parent_not_found" };

export type CommitFailedChildCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_exists" | "parent_not_found" };

export type CreateAttachmentCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_exists" | "parent_not_found" | "permission_broadened" };

export type AcquireAttachedRuntimeCommandResult =
	| { ok: true; agent: AgentSnapshot; ownership: MultiAgentRuntimeOwnership }
	| { ok: false; error: "agent_not_found" | "invalid_agent" | "ownership_held" | "mutation_mismatch" };

export interface OwnedLifecycleCommandInput {
	agent: AgentSnapshot;
	ownership: MultiAgentRuntimeOwnership;
}

export interface SteeringDeliveryCommandInput extends OwnedLifecycleCommandInput {
	messageId: string;
}

export interface SteeringCommandInput extends OwnedLifecycleCommandInput, SendSteeringInput {
	recipient: RuntimeMailboxAddress;
}

export type SteeringCommandResult =
	| { ok: true; agent: AgentSnapshot; message: AgentMailboxMessage }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "message_not_found" | "mutation_mismatch" };

export interface DetachedCancellationCommandInput extends OwnedLifecycleCommandInput {
	outputLabel: string;
	reason?: string;
}

export type LifecycleCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export interface RecoverDeadChildCommandInput extends OwnedLifecycleCommandInput {
	ownerSessionId: string;
	supervisorAgentId?: string;
}

export type RecoverDeadChildCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| {
			ok: false;
			error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" | "owner_alive";
	  };

export interface FinalizeChildCommandInput extends OwnedLifecycleCommandInput {
	error?: AgentSnapshot["error"];
	result?: AgentSnapshot["result"];
	terminalLifecycle: "completed" | "failed" | "aborted";
}

export class LifecycleCoordinator {
	private readonly options: LifecycleCoordinatorOptions;

	static reconcileDeadDetachedRuntimes(controlDbPath: string, nowIso: string): number {
		try {
			const reconciled = reconcileDeadDetachedAgentRuntimesRepository(controlDbPath, nowIso);
			clearDeadDetachedReconciliationRetry(controlDbPath);
			return reconciled;
		} catch (error) {
			if (!isSqliteContentionError(error)) throw error;
			scheduleDeadDetachedReconciliationRetry(controlDbPath);
			return 0;
		}
	}

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
		const result = acquireAttachedRuntimeOwnership(this.options.controlDbPath, {
			agentId: agent.id,
			nowIso,
			owner: { agentId: null, sessionId: ownerSessionId },
			processIdentity: this.options.processIdentity,
			sessionPath: this.options.sessionPath,
			supervisor: { processIdentity: this.options.processIdentity, sessionId: ownerSessionId },
		});
		if (!result.ok) return result;
		return { agent: result.agent, ok: true, ownership: result.ownership };
	}

	confirmChildRuntime(input: OwnedLifecycleCommandInput): LifecycleCommandResult {
		return this.commitReservedLifecycle(input, "running");
	}

	acknowledgeSteeringDelivery(input: SteeringDeliveryCommandInput): SteeringCommandResult {
		const identity = this.readOwnershipIdentity(input.ownership, input.agent.id);
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
		const identity = this.readOwnershipIdentity(input.ownership, input.agent.id);
		if (!identity) return { ok: false, error: "mutation_mismatch" };
		const result = commitMultiAgentSteeringMutation(this.options.controlDbPath, {
			agentId: input.agent.id,
			body: input.body,
			fileRefs: input.fileRefs,
			fromAgentId: input.fromAgentId,
			owner: identity.owner,
			recipient: input.recipient,
			requestedLifecycle: "steering_pending",
			processIdentity: identity.processIdentity,
			sessionPath: this.options.sessionPath,
			targetCheckpoint: input.targetCheckpoint,
			threadId: input.threadId,
			updatedAt: this.options.now(),
		});
		return result;
	}

	markWaitingForInput(input: OwnedLifecycleCommandInput): LifecycleCommandResult {
		return this.commitReservedLifecycle(input, "waiting_for_input");
	}

	/**
	 * Mark an owned background job as detached from its waiting tool call so its
	 * terminal state notifies the supervisor through the runtime mailbox.
	 */
	markDetached(input: OwnedLifecycleCommandInput): LifecycleCommandResult {
		// Detached job ownership records the runner's process identity, not this
		// supervisor's, so the mutation is fenced by the full owner predicate only.
		const identity = this.readOwnershipIdentity(input.ownership, input.agent.id, false);
		if (!identity) return { ok: false, error: "mutation_mismatch" };
		return commitMultiAgentDetachMark(this.options.controlDbPath, {
			agentId: input.agent.id,
			owner: identity.owner,
			processIdentity: identity.processIdentity,
			sessionPath: this.options.sessionPath,
			updatedAt: this.options.now(),
		});
	}

	requestCancellation(input: OwnedLifecycleCommandInput): LifecycleCommandResult {
		return this.commitReservedLifecycle(input, "cancelling");
	}

	requestDetachedCancellation(input: DetachedCancellationCommandInput): LifecycleCommandResult {
		return this.commitReservedLifecycle(
			input,
			"cancelling",
			{
				outputLabel: input.outputLabel,
				reason: input.reason,
			},
			false,
		);
	}

	acknowledgeCancellation(input: OwnedLifecycleCommandInput & { reason?: string }): LifecycleCommandResult {
		return this.finalizeChild({
			agent: input.agent,
			ownership: input.ownership,
			terminalLifecycle: "aborted",
		});
	}

	recoverDeadChild(input: RecoverDeadChildCommandInput): RecoverDeadChildCommandResult {
		const identity = this.readOwnershipIdentity(input.ownership, input.agent.id, false);
		// The recorded owner session may be a dead prior incarnation of this session
		// (every resume registers a fresh session ID), so owner.sessionId is not
		// required to equal the recovering supervisor's session. Authorization comes
		// from recoverDeadMultiAgentRuntime: the supervisor must be the live
		// registered listener asserted on this session path, and the owner process
		// must be provably dead before ownership is released in the same transaction.
		if (
			!identity ||
			identity.agentId !== input.agent.id ||
			identity.sessionPath !== this.options.sessionPath ||
			identity.owner.agentId !== (input.supervisorAgentId ?? null)
		) {
			return { ok: false, error: "mutation_mismatch" };
		}
		const nowIso = this.options.now();
		const recovered = recoverDeadMultiAgentRuntime(this.options.controlDbPath, {
			expectedOwner: identity,
			nowIso,
			supervisor: {
				agentId: input.supervisorAgentId,
				processIdentity: this.options.processIdentity,
				sessionId: input.ownerSessionId,
			},
		});
		if (!recovered.ok) return recovered;
		return { ok: true, agent: recovered.agent as unknown as AgentSnapshot };
	}

	finalizeChild(input: FinalizeChildCommandInput): LifecycleCommandResult {
		return this.finalizeOwnedChild(input, true);
	}

	failDetachedLaunch(input: FinalizeChildCommandInput): LifecycleCommandResult {
		return this.finalizeOwnedChild(input, false);
	}

	private finalizeOwnedChild(
		input: FinalizeChildCommandInput,
		requireCurrentProcess: boolean,
	): LifecycleCommandResult {
		const identity = this.readOwnershipIdentity(input.ownership, input.agent.id, requireCurrentProcess);
		if (!identity) return { ok: false, error: "mutation_mismatch" };
		const updatedAt = this.options.now();
		const result = commitMultiAgentTerminalMutation(this.options.controlDbPath, {
			agentDetails: { error: input.error, result: input.result },
			agentId: input.agent.id,
			eventKind: input.terminalLifecycle,
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

	prepareChild(input: PrepareChildCommandInput): AgentSnapshot {
		return this.buildChildSnapshot(input);
	}

	commitFailedChild(agent: AgentSnapshot, error: NonNullable<AgentSnapshot["error"]>): CommitFailedChildCommandResult {
		if (agent.revision !== 1) throw new Error("Constructed child failure must persist at revision 1");
		const nowIso = this.options.now();
		const failedAgent: AgentSnapshot = {
			...agent,
			error,
			lifecycle: "failed",
			updatedAt: nowIso,
		};
		return createFailedMultiAgentChild(this.options.controlDbPath, {
			agent: failedAgent,
			nowIso,
			sessionPath: this.options.sessionPath,
		});
	}

	commitRunningChild(
		agent: AgentSnapshot,
		ownerSessionId: string,
		processIdentity: ProcessIdentity = this.options.processIdentity,
		ownerAgentId: string | null = null,
	): CreateChildCommandResult {
		if (agent.lifecycle !== "running" || agent.revision !== 1) {
			throw new Error("Constructed child must enter persistence as running revision 1");
		}
		return this.persistChildWithOwnership(agent, ownerSessionId, processIdentity, ownerAgentId);
	}

	private buildChildSnapshot(input: PrepareChildCommandInput): AgentSnapshot {
		const nowIso = this.options.now();
		return {
			account: input.account,
			agentType: input.agentType,
			createdAt: nowIso,
			cwd: input.cwd,
			detached: input.detached,
			displayName: input.displayName,
			eventStream: input.eventStream,
			id: input.agentId ?? this.options.createAgentId(),
			lifecycle: "running",
			model: input.model,
			origin: input.origin,
			parentId: input.parentId ?? MAIN_THREAD_AGENT_ID,
			permission: { ...input.permission },
			result: input.result,
			revision: 1,
			slot: input.slot,
			transcript: input.transcript,
			updatedAt: nowIso,
			worker: input.worker,
			worktree: input.worktree,
		};
	}

	private persistChildWithOwnership(
		agent: AgentSnapshot,
		ownerSessionId: string,
		processIdentity: ProcessIdentity,
		ownerAgentId: string | null,
	): CreateChildCommandResult {
		const result = createMultiAgentChildWithRuntimeOwnership(this.options.controlDbPath, {
			agent,
			agentId: agent.id,
			nowIso: this.options.now(),
			owner: { agentId: ownerAgentId, sessionId: ownerSessionId },
			processIdentity,
			sessionPath: this.options.sessionPath,
		});
		if (!result.ok) return result;
		return { ok: true, agent, ownership: result.ownership };
	}

	private commitReservedLifecycle(
		input: OwnedLifecycleCommandInput,
		requestedLifecycle: "running" | "waiting_for_input" | "cancelling",
		detachedCancellation?: { outputLabel: string; reason?: string },
		requireCurrentProcess = true,
	): LifecycleCommandResult {
		const ownership = input.ownership;
		const identity = this.readOwnershipIdentity(ownership, input.agent.id, requireCurrentProcess);
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

	private readOwnershipIdentity(
		ownership: MultiAgentRuntimeOwnership,
		expectedAgentId: string,
		requireCurrentProcess = true,
	):
		| {
				agentId: string;
				owner: { agentId: string | null; sessionId: string };
				processIdentity: ProcessIdentity;
				sessionPath: string;
		  }
		| undefined {
		if (
			ownership.agentId !== expectedAgentId ||
			ownership.sessionPath !== this.options.sessionPath ||
			!ownership.processIdentity ||
			!ownership.owner.sessionId ||
			(requireCurrentProcess &&
				(ownership.processIdentity.pid !== this.options.processIdentity.pid ||
					ownership.processIdentity.startTimeTicks !== this.options.processIdentity.startTimeTicks))
		) {
			return undefined;
		}
		return {
			agentId: ownership.agentId,
			owner: { agentId: ownership.owner.agentId, sessionId: ownership.owner.sessionId },
			processIdentity: ownership.processIdentity,
			sessionPath: ownership.sessionPath,
		};
	}
}
