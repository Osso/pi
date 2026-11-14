import { type AgentSnapshot, isActiveLifecycle } from "../multi-agent-store.ts";
import { isProcessIdentityAlive, isSupersededRuntimeIdentity, type ProcessIdentity } from "../runtime-process.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { parseStoredJsonObject, validatePersistedAgentPayload } from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import {
	hasActivePersistedDescendant,
	type MultiAgentRuntimeOwnershipIdentity,
	type PreparedTerminalTransport,
	persistPreparedTerminalTransport,
	prepareDetachedAgentTerminalTransport,
	runtimeOwnerMatches,
	serializeProcessIdentity,
	shouldNotifyDetachedJobOwner,
} from "./detached-job-finalization.ts";
import { parseProcessIdentity, withImmediateTransaction } from "./helpers.ts";
import { readMultiAgentRuntimeOwnershipRow, readRuntimeMailboxListenerRow } from "./runtime-mailbox-enqueue.ts";
import type { RuntimeMailboxListenerRow } from "./types.ts";

export interface SupervisorRuntimeOwnership {
	agentId?: string;
	processIdentity: ProcessIdentity;
	sessionId: string;
}

export interface RecoverDeadMultiAgentRuntimeInput {
	expectedOwner: MultiAgentRuntimeOwnershipIdentity;
	nowIso: string;
	supervisor: SupervisorRuntimeOwnership;
}

export type RecoverDeadMultiAgentRuntimeResult =
	| { ok: true; agent: Record<string, unknown>; terminalRevision: number }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "owner_alive" | "mutation_mismatch" };

export const DEAD_RUNTIME_RECOVERY_MAX_ATTEMPTS = 3;

export type SupervisorRecoveryAuthority = {
	listener: RuntimeMailboxListenerRow;
	supervisor: SupervisorRuntimeOwnership;
	supervisorAgentData?: string;
};

export type DeadRuntimeRecoveryPlan = {
	agentData: string;
	processIdentityData: string;
	terminalRevision: number;
	terminalTransport?: PreparedTerminalTransport;
	updatedAgent: Record<string, unknown> & { updatedAt: string };
	updatedAgentData: string;
};

export function recoverDeadMultiAgentRuntime(
	controlDbPath: string,
	input: RecoverDeadMultiAgentRuntimeInput,
): RecoverDeadMultiAgentRuntimeResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= DEAD_RUNTIME_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
			const supervisorAuthority = readSupervisorRecoveryAuthority(
				db,
				input.expectedOwner.sessionPath,
				input.supervisor,
			);
			if (!supervisorAuthority) return { ok: false, error: "mutation_mismatch" };
			const replay = readDeadRuntimeRecoveryReplay(db, input.expectedOwner);
			if (replay) return replay;
			const recoverable = readRecoverableMultiAgentRuntime(
				db,
				input.expectedOwner,
				input.supervisor.processIdentity,
			);
			if (!recoverable.ok) return recoverable;
			const plan = prepareDeadRuntimeRecovery(recoverable, input.expectedOwner, input.nowIso);
			const result = persistDeadRuntimeRecovery(db, input.expectedOwner, plan, supervisorAuthority);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

export function readDeadRuntimeRecoveryReplay(
	db: SqliteDatabase,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
): RecoverDeadMultiAgentRuntimeResult | undefined {
	const { agentId, sessionPath } = expectedOwner;
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, agentId) as { data: string } | undefined;
	if (!row) return undefined;
	const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${sessionPath}#${agentId}`);
	if (agent.lifecycle !== "failed" && agent.lifecycle !== "aborted") return undefined;
	const error = agent.error as { code?: unknown } | undefined;
	if (error?.code !== "lost_runtime") return undefined;
	const owner = readMultiAgentRuntimeOwnershipRow(db, sessionPath, agentId);
	if (!owner || owner.process_identity !== null || owner.owner_session_id !== null || owner.owner_agent_id !== null) {
		return undefined;
	}
	validatePersistedAgentPayload(agent, `multi_agent_agents:${sessionPath}#${agentId}`);
	return { agent, ok: true, terminalRevision: Number(agent.revision) };
}

export function readSupervisorRecoveryAuthority(
	db: SqliteDatabase,
	sessionPath: string,
	supervisor: SupervisorRuntimeOwnership,
): SupervisorRecoveryAuthority | undefined {
	if (!isProcessIdentityAlive(supervisor.processIdentity)) return undefined;
	const listener = readRuntimeMailboxListenerRow(db, {
		agentId: supervisor.agentId ?? null,
		sessionId: supervisor.sessionId,
	});
	if (!listener?.runtime_instance_id || listener.pid !== supervisor.processIdentity.pid) return undefined;
	try {
		const listenerIdentity = serializeProcessIdentity(parseProcessIdentity(listener.runtime_instance_id));
		if (listenerIdentity !== serializeProcessIdentity(supervisor.processIdentity)) return undefined;
	} catch {
		return undefined;
	}
	if (!supervisor.agentId) {
		if (listener.session_path !== sessionPath || listener.session_path_asserted_at === null) return undefined;
		return { listener, supervisor };
	}
	const supervisorRow = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, supervisor.agentId) as { data: string } | undefined;
	if (!supervisorRow) return undefined;
	const snapshot = parseStoredJsonObject(
		supervisorRow.data,
		`multi_agent_agents:${sessionPath}#${supervisor.agentId}`,
	) as unknown as AgentSnapshot;
	if (snapshot.transcript?.sessionId !== supervisor.sessionId || !isActiveLifecycle(snapshot.lifecycle)) {
		return undefined;
	}
	return { listener, supervisor, supervisorAgentData: supervisorRow.data };
}

export interface DeadDetachedRuntimeCandidate {
	agent_id: string;
	data: string;
	owner_agent_id: string | null;
	owner_session_id: string | null;
	process_identity: string | null;
	session_path: string;
}

export function reconcileDeadDetachedAgentRuntimes(controlDbPath: string, nowIso: string): number {
	return withControlDb(controlDbPath, (db) => {
		const expectedOwners = readDeadDetachedRuntimeCandidates(db).flatMap((candidate) => {
			const owner = readDetachedOwnerForRecovery(db, candidate);
			return owner ? [owner] : [];
		});
		return expectedOwners.reduce(
			(count, expectedOwner) => count + reconcileDeadDetachedAgentRuntime(db, expectedOwner, nowIso),
			0,
		);
	});
}

export function reconcileDeadDetachedAgentRuntime(
	db: SqliteDatabase,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
	nowIso: string,
): number {
	for (let attempt = 1; attempt <= DEAD_RUNTIME_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
		const recoverable = readRecoverableMultiAgentRuntime(db, expectedOwner);
		if (!recoverable.ok) return 0;
		const plan = prepareDeadRuntimeRecovery(recoverable, expectedOwner, nowIso);
		const result = persistDeadRuntimeRecovery(db, expectedOwner, plan);
		if (result) return result.ok ? 1 : 0;
	}
	return 0;
}

export function readDeadDetachedRuntimeCandidates(db: SqliteDatabase): DeadDetachedRuntimeCandidate[] {
	return db
		.prepare(
			`SELECT agents.session_path, agents.agent_id, agents.data, owners.process_identity,
			 owners.owner_session_id, owners.owner_agent_id
			 FROM multi_agent_agents AS agents
			 JOIN multi_agent_runtime_owners AS owners
			 ON owners.session_path = agents.session_path AND owners.agent_id = agents.agent_id
			 WHERE json_valid(agents.data)
			 AND json_extract(agents.data, '$.lifecycle') IN ('running', 'cancelling')
			 AND json_extract(agents.data, '$.detached') = 1`,
		)
		.all() as DeadDetachedRuntimeCandidate[];
}

export function readDetachedOwnerForRecovery(
	db: SqliteDatabase,
	candidate: DeadDetachedRuntimeCandidate,
): MultiAgentRuntimeOwnershipIdentity | undefined {
	if (!candidate.owner_session_id || !candidate.process_identity) return undefined;
	const context = `multi_agent_agents:${candidate.session_path}#${candidate.agent_id}`;
	const agent = parseStoredJsonObject(candidate.data, context);
	validatePersistedAgentPayload(agent, context);
	const processIdentity = parseProcessIdentity(candidate.process_identity);
	const worker = agent.worker as AgentSnapshot["worker"] | undefined;
	if (worker?.adapter !== "runtime" || worker.handleId !== String(processIdentity.pid)) return undefined;
	if (hasTerminalOutboxRecord(db, candidate.session_path, candidate.agent_id)) return undefined;
	if (isProcessIdentityAlive(processIdentity)) return undefined;
	return {
		agentId: candidate.agent_id,
		owner: { agentId: candidate.owner_agent_id, sessionId: candidate.owner_session_id },
		processIdentity,
		sessionPath: candidate.session_path,
	};
}

export function hasTerminalOutboxRecord(db: SqliteDatabase, sessionPath: string, agentId: string): boolean {
	return Boolean(
		db
			.prepare("SELECT 1 FROM multi_agent_terminal_outbox WHERE session_path = ? AND agent_id = ? LIMIT 1")
			.get(sessionPath, agentId),
	);
}

export type RecoverDeadMultiAgentRuntimeFailure = Extract<RecoverDeadMultiAgentRuntimeResult, { ok: false }>;

export type RecoverableMultiAgentRuntime =
	| { agent: Record<string, unknown>; agentData: string; ok: true }
	| RecoverDeadMultiAgentRuntimeFailure;

export function readRecoverableMultiAgentRuntime(
	db: SqliteDatabase,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
	replacementProcessIdentity?: ProcessIdentity,
): RecoverableMultiAgentRuntime {
	const { agentId, sessionPath } = expectedOwner;
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, agentId) as { data: string } | undefined;
	if (!row) return { ok: false, error: "agent_not_found" };
	const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${sessionPath}#${agentId}`);
	if (!isRecoverableRuntimeLifecycle(agent.lifecycle)) return { ok: false, error: "invalid_transition" };
	const owner = readMultiAgentRuntimeOwnershipRow(db, sessionPath, agentId);
	if (!runtimeOwnerMatches(owner, expectedOwner)) return { ok: false, error: "mutation_mismatch" };
	if (hasActivePersistedDescendant(db, sessionPath, agentId)) return { ok: false, error: "invalid_transition" };
	const ownerAlive = isProcessIdentityAlive(expectedOwner.processIdentity);
	const ownerSuperseded =
		replacementProcessIdentity !== undefined &&
		isSupersededRuntimeIdentity(expectedOwner.processIdentity, replacementProcessIdentity);
	if (replacementProcessIdentity !== undefined && ownerAlive && !ownerSuperseded) {
		return { ok: false, error: "owner_alive" };
	}
	return { agent, agentData: row.data, ok: true };
}

export function prepareDeadRuntimeRecovery(
	recoverable: Extract<RecoverableMultiAgentRuntime, { ok: true }>,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
	nowIso: string,
): DeadRuntimeRecoveryPlan {
	const { agent } = recoverable;
	const terminalRevision = Number(agent.revision) + 1;
	const cancelling = agent.lifecycle === "cancelling";
	const error = {
		code: "lost_runtime",
		message: cancelling
			? "Cancellation requested; agent owner process exited before terminal confirmation."
			: "Agent owner process exited before terminal confirmation.",
	};
	const worker = agent.worker as AgentSnapshot["worker"] | undefined;
	const result = agent.result as AgentSnapshot["result"] | undefined;
	const toolCallId = worker?.toolCallId;
	const updatedAgent = {
		...agent,
		error,
		lifecycle: cancelling ? "aborted" : "failed",
		...(toolCallId === undefined ? {} : { result: { ...result, toolCallId } }),
		revision: terminalRevision,
		updatedAt: nowIso,
		worker: undefined,
	};
	const terminalTransport = shouldNotifyDetachedJobOwner(agent)
		? prepareDetachedAgentTerminalTransport(
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				expectedOwner.owner,
				terminalRevision,
				"lost_runtime",
				nowIso,
			)
		: undefined;
	return {
		agentData: recoverable.agentData,
		processIdentityData: serializeProcessIdentity(expectedOwner.processIdentity),
		terminalRevision,
		terminalTransport,
		updatedAgent,
		updatedAgentData: JSON.stringify(updatedAgent),
	};
}

export function persistDeadRuntimeRecovery(
	db: SqliteDatabase,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
	plan: DeadRuntimeRecoveryPlan,
	supervisorAuthority?: SupervisorRecoveryAuthority,
): RecoverDeadMultiAgentRuntimeResult | undefined {
	return withImmediateTransaction(db, () => {
		if (!releaseDeadRuntimeOwnershipIfCurrent(db, expectedOwner, plan, supervisorAuthority)) return undefined;
		const agentUpdated = db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ?`,
			)
			.run(
				plan.updatedAgentData,
				plan.updatedAgent.updatedAt,
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				plan.agentData,
			).changes;
		if (agentUpdated !== 1) {
			throw new Error(
				`Recovered agent changed after ownership release ${expectedOwner.sessionPath}#${expectedOwner.agentId}`,
			);
		}
		db.prepare(
			`INSERT INTO multi_agent_terminal_outbox
				(session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at)
			 VALUES (?, ?, ?, 'lost_runtime', 'pending', 0, ?)`,
		).run(expectedOwner.sessionPath, expectedOwner.agentId, plan.terminalRevision, plan.updatedAgent.updatedAt);
		if (plan.terminalTransport) persistPreparedTerminalTransport(db, plan.terminalTransport);
		return { agent: plan.updatedAgent, ok: true, terminalRevision: plan.terminalRevision };
	});
}

export function releaseDeadRuntimeOwnershipIfCurrent(
	db: SqliteDatabase,
	expectedOwner: MultiAgentRuntimeOwnershipIdentity,
	plan: DeadRuntimeRecoveryPlan,
	supervisorAuthority?: SupervisorRecoveryAuthority,
): boolean {
	const listener = supervisorAuthority?.listener;
	const supervisor = supervisorAuthority?.supervisor;
	const supervisorAgentData = supervisorAuthority?.supervisorAgentData;
	return (
		db
			.prepare(
				`WITH RECURSIVE descendants(agent_id) AS (
					SELECT agent_id FROM multi_agent_agents
					WHERE session_path = ? AND json_valid(data)
					AND json_extract(data, '$.parentId') = ?
					UNION
					SELECT child.agent_id FROM multi_agent_agents AS child
					JOIN descendants AS parent
						ON json_valid(child.data) AND json_extract(child.data, '$.parentId') = parent.agent_id
					WHERE child.session_path = ?
				)
				UPDATE multi_agent_runtime_owners
				SET process_identity = NULL, owner_session_id = NULL, owner_agent_id = NULL
				WHERE session_path = ? AND agent_id = ? AND process_identity = ?
				AND owner_session_id = ? AND owner_agent_id IS ?
				AND EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND agent_id = ? AND data = ?
				)
				AND NOT EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND NOT json_valid(data)
				)
				AND NOT EXISTS (
					SELECT 1 FROM multi_agent_agents AS active
					JOIN descendants ON descendants.agent_id = active.agent_id
					WHERE active.session_path = ?
					AND json_extract(active.data, '$.lifecycle') NOT IN ('completed', 'failed', 'aborted')
				)
				AND NOT EXISTS (
					SELECT 1 FROM multi_agent_terminal_outbox
					WHERE session_path = ? AND agent_id = ?
				)
				AND (? = 0 OR EXISTS (
					SELECT 1 FROM runtime_mailbox_listeners
					WHERE recipient_session_id = ? AND recipient_agent_id_key = ? AND pid = ?
					AND runtime_instance_id IS ? AND session_path IS ?
					AND session_path_asserted_at IS ? AND updated_at = ?
				))
				AND (? = 0 OR EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND agent_id = ? AND data = ?
				))`,
			)
			.run(
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				expectedOwner.sessionPath,
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				plan.processIdentityData,
				expectedOwner.owner.sessionId,
				expectedOwner.owner.agentId,
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				plan.agentData,
				expectedOwner.sessionPath,
				expectedOwner.sessionPath,
				expectedOwner.sessionPath,
				expectedOwner.agentId,
				supervisorAuthority ? 1 : 0,
				supervisor?.sessionId ?? null,
				supervisor?.agentId ?? "",
				listener?.pid ?? null,
				listener?.runtime_instance_id ?? null,
				listener?.session_path ?? null,
				listener?.session_path_asserted_at ?? null,
				listener?.updated_at ?? null,
				supervisorAgentData ? 1 : 0,
				expectedOwner.sessionPath,
				supervisor?.agentId ?? null,
				supervisorAgentData ?? null,
			).changes === 1
	);
}

export function isRecoverableRuntimeLifecycle(value: unknown): boolean {
	return (
		value === "waiting_for_input" || value === "running" || value === "steering_pending" || value === "cancelling"
	);
}
