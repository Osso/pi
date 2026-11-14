import type { ProcessIdentity } from "../runtime-process.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { parseStoredJsonObject } from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import {
	hasActivePersistedDescendant,
	runtimeOwnerMatches,
	serializeProcessIdentity,
	updateTerminalAgentIfCurrent,
} from "./detached-job-finalization.ts";
import { withImmediateTransaction } from "./helpers.ts";
import { assertMailboxMessageFresh, readMultiAgentRuntimeOwnershipRow } from "./runtime-mailbox-enqueue.ts";

export interface CommitMultiAgentLifecycleMutationInput {
	sessionPath: string;
	agentId: string;
	processIdentity: ProcessIdentity;
	owner: { sessionId: string; agentId: string | null };
	requestedLifecycle: string;
	updatedAt: string;
	detachedCancellation?: {
		outputLabel: string;
		reason?: string;
		suppressTerminalNotification?: boolean;
	};
}

export type CommitMultiAgentLifecycleMutationResult =
	| { ok: true; agent: Record<string, unknown> }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export interface CommitMultiAgentTerminalMutationInput {
	sessionPath: string;
	agentId: string;
	processIdentity: ProcessIdentity;
	owner: { sessionId: string; agentId: string | null };
	terminalLifecycle: "completed" | "failed" | "aborted";
	eventKind: string;
	agentDetails?: { error?: unknown; result?: unknown };
	updatedAt: string;
}

export type CommitMultiAgentTerminalMutationResult =
	| { ok: true; terminalRevision: number }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export const MULTI_AGENT_LIFECYCLE_MUTATION_MAX_ATTEMPTS = 3;

export type DetachedCancellationCommand = { message: string; messageId: string };

export type MultiAgentLifecycleMutationPlan = {
	agentData: string;
	cancellation?: DetachedCancellationCommand;
	processIdentityData: string;
	updatedAgent: Record<string, unknown>;
	updatedAgentData: string;
};

export type MultiAgentLifecycleMutationPreflight =
	| { plan: MultiAgentLifecycleMutationPlan }
	| { result: CommitMultiAgentLifecycleMutationResult };

export type MultiAgentLifecycleAgentUpdate =
	| { result: CommitMultiAgentLifecycleMutationResult }
	| { cancellation?: DetachedCancellationCommand; updatedAgent: Record<string, unknown> };

export function commitMultiAgentLifecycleMutation(
	controlDbPath: string,
	input: CommitMultiAgentLifecycleMutationInput,
): CommitMultiAgentLifecycleMutationResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_LIFECYCLE_MUTATION_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareMultiAgentLifecycleMutation(db, input);
			if ("result" in preflight) return preflight.result;
			if (persistMultiAgentLifecycleMutation(db, input, preflight.plan)) {
				return { agent: preflight.plan.updatedAgent, ok: true };
			}
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

export function prepareMultiAgentLifecycleMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentLifecycleMutationInput,
): MultiAgentLifecycleMutationPreflight {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.agentId) as { data: string } | undefined;
	if (!row) return { result: { ok: false, error: "agent_not_found" } };
	const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	if (!runtimeOwnerMatches(ownership, input)) return { result: { ok: false, error: "mutation_mismatch" } };
	const preparedUpdate = prepareMultiAgentLifecycleAgentUpdate(agent, input);
	if ("result" in preparedUpdate) return preparedUpdate;
	return {
		plan: {
			agentData: row.data,
			cancellation: preparedUpdate.cancellation,
			processIdentityData: serializeProcessIdentity(input.processIdentity),
			updatedAgent: preparedUpdate.updatedAgent,
			updatedAgentData: JSON.stringify(preparedUpdate.updatedAgent),
		},
	};
}

export function prepareMultiAgentLifecycleAgentUpdate(
	agent: Record<string, unknown>,
	input: CommitMultiAgentLifecycleMutationInput,
): MultiAgentLifecycleAgentUpdate {
	const shouldPersistNotificationSuppression =
		input.detachedCancellation?.suppressTerminalNotification === true && agent.suppressTerminalNotification !== true;
	if (agent.lifecycle === input.requestedLifecycle && !shouldPersistNotificationSuppression) {
		return { result: { ok: true, agent } };
	}
	if (
		agent.lifecycle !== input.requestedLifecycle &&
		!canPersistLifecycleTransition(agent.lifecycle, input.requestedLifecycle)
	) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	const updatedAgent = {
		...agent,
		...(shouldPersistNotificationSuppression ? { suppressTerminalNotification: true } : {}),
		lifecycle: input.requestedLifecycle,
		revision: Number(agent.revision) + 1,
		updatedAt: input.updatedAt,
	};
	const cancellation =
		input.detachedCancellation && agent.lifecycle !== input.requestedLifecycle
			? buildDetachedCancellationMessage(input, input.detachedCancellation, updatedAgent.revision)
			: undefined;
	return { cancellation, updatedAgent };
}

export function persistMultiAgentLifecycleMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentLifecycleMutationInput,
	plan: MultiAgentLifecycleMutationPlan,
): boolean {
	return withImmediateTransaction(db, () => {
		const updated = db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ?
				 AND EXISTS (
					SELECT 1 FROM multi_agent_runtime_owners
					WHERE session_path = ? AND agent_id = ? AND process_identity = ?
					AND owner_session_id = ? AND owner_agent_id IS ?
				 )`,
			)
			.run(
				plan.updatedAgentData,
				input.updatedAt,
				input.sessionPath,
				input.agentId,
				plan.agentData,
				input.sessionPath,
				input.agentId,
				plan.processIdentityData,
				input.owner.sessionId,
				input.owner.agentId,
			).changes;
		if (updated !== 1) return false;
		if (plan.cancellation) persistDetachedCancellationCommand(db, input, plan.cancellation);
		return true;
	});
}

export function persistDetachedCancellationCommand(
	db: SqliteDatabase,
	input: CommitMultiAgentLifecycleMutationInput,
	command: DetachedCancellationCommand,
): void {
	assertMailboxMessageFresh(
		{ createdAt: input.updatedAt },
		`multi_agent_mailbox_messages:${input.sessionPath}#${command.messageId}`,
	);
	db.prepare(
		`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
		 VALUES (?, ?, ?, ?)`,
	).run(input.sessionPath, command.messageId, command.message, input.updatedAt);
}

export function buildDetachedCancellationMessage(
	input: CommitMultiAgentLifecycleMutationInput,
	cancellation: NonNullable<CommitMultiAgentLifecycleMutationInput["detachedCancellation"]>,
	cancellingRevision: number,
): { message: string; messageId: string } {
	const messageId = `detached-cancel:${input.agentId}:${cancellingRevision}`;
	const body = JSON.stringify({
		command: "cancel",
		identity: {
			jobId: input.agentId,
			outputLabel: cancellation.outputLabel,
			owner: input.owner,
			processIdentity: input.processIdentity,
		},
		reason: cancellation.reason,
	});
	return {
		message: JSON.stringify({
			body,
			createdAt: input.updatedAt,
			fromAgentId: "main",
			id: messageId,
			kind: "system",
			recipientAgentId: input.agentId,
			recipientSessionId: input.owner.sessionId,
			senderAgentId: null,
			senderSessionId: input.owner.sessionId,
			status: "pending",
			toAgentId: input.agentId,
		}),
		messageId,
	};
}

export function canPersistLifecycleTransition(current: unknown, requested: string): boolean {
	if (typeof current !== "string") return false;
	const transitions: Record<string, readonly string[]> = {
		running: ["waiting_for_input", "steering_pending", "cancelling", "completed", "failed", "aborted"],
		waiting_for_input: ["running", "steering_pending", "cancelling", "completed", "aborted"],
		steering_pending: ["running", "cancelling", "failed", "aborted"],
		cancelling: ["aborted", "failed"],
		completed: [],
		failed: [],
		aborted: [],
	};
	return current === requested
		? !["completed", "failed", "aborted"].includes(current)
		: transitions[current]?.includes(requested) === true;
}

export const MULTI_AGENT_TERMINAL_MUTATION_MAX_ATTEMPTS = 3;

export type MultiAgentTerminalMutationPlan = {
	agentData: string;
	processIdentityData: string;
	terminalRevision: number;
	updatedAgentData: string;
};

export type MultiAgentTerminalMutationPreflight =
	| { plan: MultiAgentTerminalMutationPlan }
	| { result: CommitMultiAgentTerminalMutationResult };

export function commitMultiAgentTerminalMutation(
	controlDbPath: string,
	input: CommitMultiAgentTerminalMutationInput,
): CommitMultiAgentTerminalMutationResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_TERMINAL_MUTATION_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareMultiAgentTerminalMutation(db, input);
			if ("result" in preflight) return preflight.result;
			const result = persistMultiAgentTerminalMutation(db, input, preflight.plan);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

export function prepareMultiAgentTerminalMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentTerminalMutationInput,
): MultiAgentTerminalMutationPreflight {
	const agentRow = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.agentId) as { data: string } | undefined;
	if (!agentRow) return { result: { ok: false, error: "agent_not_found" } };
	const agent = parseStoredJsonObject(agentRow.data, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	if (!runtimeOwnerMatches(ownership, input)) {
		return { result: { ok: false, error: "mutation_mismatch" } };
	}
	if (agent.lifecycle === input.terminalLifecycle) {
		return { result: terminalMutationReplayResult(input, agent, Number(agent.revision)) };
	}
	const terminalRevision = Number(agent.revision) + 1;
	if (!canPersistTerminalTransition(agent.lifecycle, input.terminalLifecycle)) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	if (hasActivePersistedDescendant(db, input.sessionPath, input.agentId)) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	const updatedAgent = {
		...agent,
		...input.agentDetails,
		currentActivity: undefined,
		lifecycle: input.terminalLifecycle,
		revision: terminalRevision,
		updatedAt: input.updatedAt,
	};
	return {
		plan: {
			agentData: agentRow.data,
			processIdentityData: serializeProcessIdentity(input.processIdentity),
			terminalRevision,
			updatedAgentData: JSON.stringify(updatedAgent),
		},
	};
}

export function persistMultiAgentTerminalMutation(
	db: SqliteDatabase,
	input: CommitMultiAgentTerminalMutationInput,
	plan: MultiAgentTerminalMutationPlan,
): CommitMultiAgentTerminalMutationResult | undefined {
	return withImmediateTransaction(db, () => {
		const agentUpdated = updateTerminalAgentIfCurrent(db, {
			agentData: plan.agentData,
			agentId: input.agentId,
			owner: input.owner,
			processIdentityData: plan.processIdentityData,
			requireUniqueOwnership: false,
			sessionPath: input.sessionPath,
			updatedAgentData: plan.updatedAgentData,
			updatedAt: input.updatedAt,
		});
		if (!agentUpdated) return undefined;
		db.prepare(
			`INSERT INTO multi_agent_terminal_outbox (
				session_path, agent_id, terminal_revision, event_kind, status,
				claim_id, claimed_at, attempt_count, last_error, updated_at
			) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, 0, NULL, ?)`,
		).run(input.sessionPath, input.agentId, plan.terminalRevision, input.eventKind, input.updatedAt);
		return { ok: true, terminalRevision: plan.terminalRevision };
	});
}

export function terminalMutationReplayResult(
	input: CommitMultiAgentTerminalMutationInput,
	agent: Record<string, unknown>,
	terminalRevision: number,
): CommitMultiAgentTerminalMutationResult {
	for (const [key, value] of Object.entries(input.agentDetails ?? {})) {
		if (JSON.stringify(agent[key]) !== JSON.stringify(value)) return { ok: false, error: "mutation_mismatch" };
	}
	return { ok: true, terminalRevision };
}

export function canPersistTerminalTransition(
	current: unknown,
	requested: CommitMultiAgentTerminalMutationInput["terminalLifecycle"],
): boolean {
	if (typeof current !== "string") return false;
	const allowedFrom =
		requested === "completed"
			? new Set(["running", "waiting_for_input"])
			: new Set(["running", "waiting_for_input", "steering_pending", "cancelling"]);
	return allowedFrom.has(current);
}
