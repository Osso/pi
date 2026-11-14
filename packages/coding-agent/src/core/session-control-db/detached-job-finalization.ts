import type { DetachedJobTerminalInput } from "../detached-job-runner.ts";
import type { AgentSnapshot } from "../multi-agent-store.ts";
import type { ProcessIdentity } from "../runtime-process.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import {
	isNonterminalLifecycle,
	parseFileRefs,
	parseStoredJsonObject,
	validatePersistedAgentPayload,
} from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import { withImmediateTransaction } from "./helpers.ts";
import {
	assertMailboxMessageFresh,
	type MultiAgentRuntimeOwnershipRow,
	type PreparedStoredRuntimeMailboxMessage,
	prepareStoredRuntimeMailboxMessage,
	readMultiAgentRuntimeOwnershipRow,
} from "./runtime-mailbox-enqueue.ts";
import type { EnqueueStoredRuntimeMailboxMessageInput } from "./types.ts";

export interface MultiAgentRuntimeOwnershipIdentity {
	sessionPath: string;
	agentId: string;
	processIdentity: ProcessIdentity;
	owner: { sessionId: string; agentId: string | null };
}

export interface FinalizeDetachedJobInput {
	sessionPath: string;
	terminal: DetachedJobTerminalInput;
}

export type FinalizeDetachedJobResult =
	| { ok: true; terminalAgent: AgentSnapshot; terminalRevision: number }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export function runtimeOwnerMatches(
	owner: MultiAgentRuntimeOwnershipRow | undefined,
	identity: MultiAgentRuntimeOwnershipIdentity,
): boolean {
	return (
		owner?.process_identity === serializeProcessIdentity(identity.processIdentity) &&
		owner.owner_session_id === identity.owner.sessionId &&
		owner.owner_agent_id === identity.owner.agentId
	);
}

export type TerminalAgentCasInput = {
	agentData: string;
	agentId: string;
	owner: { agentId: string | null; sessionId: string };
	processIdentityData: string;
	requireUniqueOwnership: boolean;
	sessionPath: string;
	updatedAgentData: string;
	updatedAt: string;
};

export function updateTerminalAgentIfCurrent(db: SqliteDatabase, input: TerminalAgentCasInput): boolean {
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
				UPDATE multi_agent_agents SET data = ?, updated_at = ?
				WHERE session_path = ? AND agent_id = ? AND data = ?
				AND EXISTS (
					SELECT 1 FROM multi_agent_runtime_owners
					WHERE session_path = ? AND agent_id = ? AND process_identity = ?
					AND owner_session_id = ? AND owner_agent_id IS ?
				)
				AND (? = 0 OR (
					SELECT COUNT(*) FROM multi_agent_runtime_owners AS matching_owner
					WHERE matching_owner.agent_id = ? AND matching_owner.process_identity = ?
					AND matching_owner.owner_session_id = ? AND matching_owner.owner_agent_id IS ?
				) = 1)
				AND NOT EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND NOT json_valid(data)
				)
				AND NOT EXISTS (
					SELECT 1 FROM multi_agent_agents AS active
					JOIN descendants ON descendants.agent_id = active.agent_id
					WHERE active.session_path = ?
					AND json_extract(active.data, '$.lifecycle') NOT IN ('completed', 'failed', 'aborted')
				)`,
			)
			.run(
				input.sessionPath,
				input.agentId,
				input.sessionPath,
				input.updatedAgentData,
				input.updatedAt,
				input.sessionPath,
				input.agentId,
				input.agentData,
				input.sessionPath,
				input.agentId,
				input.processIdentityData,
				input.owner.sessionId,
				input.owner.agentId,
				input.requireUniqueOwnership ? 1 : 0,
				input.agentId,
				input.processIdentityData,
				input.owner.sessionId,
				input.owner.agentId,
				input.sessionPath,
				input.sessionPath,
			).changes === 1
	);
}

export function hasActivePersistedDescendant(db: SqliteDatabase, sessionPath: string, ancestorId: string): boolean {
	const rows = db
		.prepare("SELECT agent_id, data FROM multi_agent_agents WHERE session_path = ?")
		.all(sessionPath) as Array<{ agent_id: string; data: string }>;
	const agents = new Map(
		rows.map((row) => [
			row.agent_id,
			parseStoredJsonObject(row.data, `multi_agent_agents:${sessionPath}#${row.agent_id}`),
		]),
	);
	for (const [agentId, agent] of agents) {
		if (!isNonterminalLifecycle(agent.lifecycle)) continue;
		let parentId = typeof agent.parentId === "string" ? agent.parentId : undefined;
		const visited = new Set<string>([agentId]);
		while (parentId && !visited.has(parentId)) {
			if (parentId === ancestorId) return true;
			visited.add(parentId);
			const parent = agents.get(parentId);
			parentId = typeof parent?.parentId === "string" ? parent.parentId : undefined;
		}
	}
	return false;
}

export const FINALIZE_DETACHED_JOB_MAX_ATTEMPTS = 3;

export type PreparedTerminalTransport = {
	input: EnqueueStoredRuntimeMailboxMessageInput;
	prepared: PreparedStoredRuntimeMailboxMessage;
};

export type FinalizeDetachedJobPlan = {
	agentData: string;
	eventKind: string;
	ownership: MultiAgentRuntimeOwnershipRow;
	processIdentityData: string;
	sessionPath: string;
	terminalAgent: AgentSnapshot;
	terminalAgentData: string;
	terminalRevision: number;
	terminalTransport?: PreparedTerminalTransport;
};

export type FinalizeDetachedJobPreflight = { plan: FinalizeDetachedJobPlan } | { result: FinalizeDetachedJobResult };

export function finalizeDetachedJob(controlDbPath: string, input: FinalizeDetachedJobInput): FinalizeDetachedJobResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= FINALIZE_DETACHED_JOB_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareDetachedJobFinalization(db, input);
			if ("result" in preflight) return preflight.result;
			const result = persistDetachedJobFinalization(db, input.terminal, preflight.plan);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

export function findDetachedJobSessionPath(db: SqliteDatabase, input: FinalizeDetachedJobInput): string | undefined {
	const candidates = db
		.prepare("SELECT session_path FROM multi_agent_runtime_owners WHERE agent_id = ?")
		.all(input.terminal.jobId) as Array<{ session_path: string }>;
	const matchingPaths = candidates.filter(({ session_path: sessionPath }) => {
		const ownership = readMultiAgentRuntimeOwnershipRow(db, sessionPath, input.terminal.jobId);
		return runtimeOwnerMatches(ownership, {
			agentId: input.terminal.jobId,
			owner: input.terminal.owner,
			processIdentity: input.terminal.processIdentity,
			sessionPath,
		});
	});
	return matchingPaths.length === 1 ? matchingPaths[0]?.session_path : undefined;
}

export function detachedJobLookupFailure(
	db: SqliteDatabase,
	input: FinalizeDetachedJobInput,
): FinalizeDetachedJobResult {
	const agent = db
		.prepare("SELECT 1 FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(input.sessionPath, input.terminal.jobId);
	return agent ? { ok: false, error: "mutation_mismatch" } : { ok: false, error: "agent_not_found" };
}

export function prepareDetachedJobFinalization(
	db: SqliteDatabase,
	input: FinalizeDetachedJobInput,
): FinalizeDetachedJobPreflight {
	const sessionPath = findDetachedJobSessionPath(db, input);
	if (!sessionPath) return { result: detachedJobLookupFailure(db, input) };
	const terminal = input.terminal;
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, terminal.jobId) as { data: string } | undefined;
	if (!row) return { result: { ok: false, error: "agent_not_found" } };
	const context = `multi_agent_agents:${sessionPath}#${terminal.jobId}`;
	const agent = parseStoredJsonObject(row.data, context);
	const terminalLifecycle = resolveDetachedJobTerminalLifecycle(agent.lifecycle, terminal);
	const eventKind = `detached_job_${terminalLifecycle}`;
	const ownership = readMultiAgentRuntimeOwnershipRow(db, sessionPath, terminal.jobId);
	if (!ownership || !detachedJobOwnershipMatches(ownership, sessionPath, terminal)) {
		return { result: { ok: false, error: "mutation_mismatch" } };
	}
	if (agent.lifecycle === terminalLifecycle) {
		return {
			result: detachedJobReplayResult(sessionPath, terminal, agent, Number(agent.revision)),
		};
	}
	const terminalRevision = Number(agent.revision) + 1;
	const canFinalize = agent.lifecycle === "running" || agent.lifecycle === "cancelling";
	if (!canFinalize || hasActivePersistedDescendant(db, sessionPath, terminal.jobId)) {
		return { result: { ok: false, error: "invalid_transition" } };
	}
	const terminalAgent = {
		...agent,
		...detachedJobAgentDetails(agent, terminal, terminalLifecycle),
		currentActivity: undefined,
		lifecycle: terminalLifecycle,
		revision: terminalRevision,
		updatedAt: terminal.terminalAt,
		worker: undefined,
	};
	validatePersistedAgentPayload(terminalAgent, context);
	const terminalTransport = shouldNotifyDetachedJobOwner(agent)
		? prepareDetachedAgentTerminalTransport(
				sessionPath,
				terminal.jobId,
				{
					agentId: ownership.owner_agent_id,
					sessionId: ownership.owner_session_id ?? undefined,
				},
				terminalRevision,
				eventKind,
				terminal.terminalAt,
			)
		: undefined;
	return {
		plan: {
			agentData: row.data,
			eventKind,
			ownership,
			processIdentityData: serializeProcessIdentity(terminal.processIdentity),
			sessionPath,
			terminalAgent: terminalAgent as unknown as AgentSnapshot,
			terminalAgentData: JSON.stringify(terminalAgent),
			terminalRevision,
			terminalTransport,
		},
	};
}

export function resolveDetachedJobTerminalLifecycle(
	persistedLifecycle: unknown,
	terminal: DetachedJobTerminalInput,
): "aborted" | "completed" | "failed" {
	if (persistedLifecycle === "completed" || persistedLifecycle === "failed" || persistedLifecycle === "aborted") {
		return persistedLifecycle;
	}
	return persistedLifecycle === "cancelling" ? "aborted" : terminal.outcome.kind;
}

export function detachedJobOwnershipMatches(
	ownership: MultiAgentRuntimeOwnershipRow,
	sessionPath: string,
	terminal: DetachedJobTerminalInput,
): boolean {
	return runtimeOwnerMatches(ownership, {
		agentId: terminal.jobId,
		owner: terminal.owner,
		processIdentity: terminal.processIdentity,
		sessionPath,
	});
}

export function detachedJobReplayResult(
	sessionPath: string,
	terminal: DetachedJobTerminalInput,
	terminalAgent: Record<string, unknown>,
	terminalRevision: number,
): FinalizeDetachedJobResult {
	const expectedDetails = detachedJobAgentDetails(
		terminalAgent,
		terminal,
		terminalAgent.lifecycle as "completed" | "failed" | "aborted",
	);
	for (const [key, value] of Object.entries(expectedDetails)) {
		if (JSON.stringify(terminalAgent[key]) !== JSON.stringify(value))
			return { ok: false, error: "mutation_mismatch" };
	}
	validatePersistedAgentPayload(terminalAgent, `multi_agent_agents:${sessionPath}#${terminal.jobId}`);
	return { ok: true, terminalAgent: terminalAgent as unknown as AgentSnapshot, terminalRevision };
}

export function persistDetachedJobFinalization(
	db: SqliteDatabase,
	terminal: DetachedJobTerminalInput,
	plan: FinalizeDetachedJobPlan,
): FinalizeDetachedJobResult | undefined {
	return withImmediateTransaction(db, () => {
		const agentUpdated = updateTerminalAgentIfCurrent(db, {
			agentData: plan.agentData,
			agentId: terminal.jobId,
			owner: terminal.owner,
			processIdentityData: plan.processIdentityData,
			requireUniqueOwnership: true,
			sessionPath: plan.sessionPath,
			updatedAgentData: plan.terminalAgentData,
			updatedAt: terminal.terminalAt,
		});
		if (!agentUpdated) return undefined;
		db.prepare(
			`INSERT INTO multi_agent_terminal_outbox
				(session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at)
			 VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
		).run(plan.sessionPath, terminal.jobId, plan.terminalRevision, plan.eventKind, terminal.terminalAt);
		// Attended jobs deliver their result in-band through the waiting tool call;
		// only jobs explicitly detached from their tool call notify the supervisor.
		if (plan.terminalTransport) persistPreparedTerminalTransport(db, plan.terminalTransport);
		return { ok: true, terminalAgent: plan.terminalAgent, terminalRevision: plan.terminalRevision };
	});
}

export function shouldNotifyDetachedJobOwner(agent: Record<string, unknown>): boolean {
	return agent.detached === true && agent.suppressTerminalNotification !== true;
}

export function prepareDetachedAgentTerminalTransport(
	sessionPath: string,
	agentId: string,
	owner: { agentId: string | null; sessionId?: string },
	terminalRevision: number,
	eventKind: string,
	terminalAt: string,
): PreparedTerminalTransport {
	const ownerSessionId = owner.sessionId;
	if (!ownerSessionId) throw new Error(`Detached job ${agentId} ownership has no owner session`);
	const messageId = `terminal:${agentId}:${terminalRevision}:${eventKind}`;
	const body = JSON.stringify({ agentId, eventKind, terminalRevision, type: "multi_agent_terminal" });
	const input: EnqueueStoredRuntimeMailboxMessageInput = {
		kind: "system",
		message: {
			body,
			createdAt: terminalAt,
			fromAgentId: agentId,
			id: messageId,
			kind: "system",
			status: "pending",
			toAgentId: owner.agentId ?? "main",
			updatedAt: terminalAt,
		},
		recipient: { agentId: owner.agentId, sessionId: ownerSessionId },
		sender: { agentId, sessionId: ownerSessionId },
		storeRef: { messageId, sessionPath },
		updatedAt: terminalAt,
	};
	return { input, prepared: prepareStoredRuntimeMailboxMessage(input) };
}

export function persistPreparedTerminalTransport(db: SqliteDatabase, transport: PreparedTerminalTransport): void {
	assertMailboxMessageFresh(transport.prepared.routed, transport.prepared.context);
	db.prepare(
		`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
		 VALUES (?, ?, ?, ?)`,
	).run(
		transport.input.storeRef.sessionPath,
		transport.input.storeRef.messageId,
		transport.prepared.serialized,
		transport.prepared.updatedAt,
	);
}

export function detachedJobAgentDetails(
	agent: Record<string, unknown>,
	terminal: DetachedJobTerminalInput,
	terminalLifecycle: "completed" | "failed" | "aborted",
): Record<string, unknown> {
	const result = agent.result;
	const existingFileRefs =
		result && typeof result === "object" && !Array.isArray(result)
			? (parseFileRefs((result as Record<string, unknown>).fileRefs, `detached job ${terminal.jobId} result`) ?? [])
			: [];
	const outputRef = { label: terminal.output.label, path: terminal.output.path };
	const fileRefs = [
		outputRef,
		...existingFileRefs.filter((fileRef) => fileRef.label !== outputRef.label || fileRef.path !== outputRef.path),
	];
	const timing = terminal.durationMs === undefined ? {} : { durationMs: terminal.durationMs };
	const correlation = terminal.toolCallId === undefined ? {} : { toolCallId: terminal.toolCallId };
	if (terminalLifecycle === "aborted") return { result: { fileRefs, ...timing, ...correlation } };
	if (terminal.outcome.kind === "completed") {
		return { result: { fileRefs, summary: terminal.outcome.summary, ...timing, ...correlation } };
	}
	if (terminal.outcome.kind === "failed") {
		return {
			error: terminal.outcome.error,
			result: { fileRefs, summary: terminal.outcome.error.message, ...timing, ...correlation },
		};
	}
	return { result: { fileRefs, ...timing, ...correlation } };
}

export function serializeProcessIdentity(identity: ProcessIdentity): string {
	return JSON.stringify(identity);
}
