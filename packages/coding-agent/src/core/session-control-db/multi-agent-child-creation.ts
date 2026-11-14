import type { AgentSnapshot } from "../multi-agent-store.ts";
import type { ProcessIdentity } from "../runtime-process.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { isNonterminalLifecycle, parseStoredJsonObject, validatePersistedAgentPayload } from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import type { MultiAgentRuntimeOwnershipIdentity } from "./detached-job-finalization.ts";
import { serializeProcessIdentity } from "./detached-job-finalization.ts";
import { withImmediateTransaction } from "./helpers.ts";

export interface CreateMultiAgentChildWithRuntimeOwnershipInput extends AcquireMultiAgentRuntimeOwnershipInput {
	agent: object;
}

export type CreateMultiAgentChildWithRuntimeOwnershipResult =
	| { ok: true; agent: object; ownership: MultiAgentRuntimeOwnership }
	| { ok: false; error: "agent_exists" | "parent_not_found" };

export interface CreateFailedMultiAgentChildInput {
	agent: AgentSnapshot;
	nowIso: string;
	sessionPath: string;
}

export type CreateFailedMultiAgentChildResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_exists" | "parent_not_found" };

export interface MultiAgentRuntimeOwnership {
	sessionPath: string;
	agentId: string;
	processIdentity?: ProcessIdentity;
	owner: { sessionId?: string; agentId: string | null };
}

export interface AcquireMultiAgentRuntimeOwnershipInput extends MultiAgentRuntimeOwnershipIdentity {
	nowIso: string;
}

export const MULTI_AGENT_CREATION_MAX_ATTEMPTS = 3;

export type ActiveParentSnapshot = {
	agent?: AgentSnapshot;
	data?: string;
	parentId: string;
};

export function createFailedMultiAgentChild(
	controlDbPath: string,
	input: CreateFailedMultiAgentChildInput,
): CreateFailedMultiAgentChildResult {
	const agent = input.agent as AgentSnapshot & Record<string, unknown>;
	validatePersistedAgentPayload(agent, `multi_agent_agents:${input.sessionPath}#${agent.id}`);
	if (agent.lifecycle !== "failed" || agent.revision !== 1) {
		throw new Error("Failed child creation requires failed revision 1");
	}
	const parentId = agent.parentId;
	if (!parentId) return { ok: false, error: "parent_not_found" };
	const serializedAgent = JSON.stringify(agent);
	return withControlDb(controlDbPath, (db) =>
		createFailedMultiAgentChildWithDb(db, input, agent, parentId, serializedAgent),
	);
}

export function createFailedMultiAgentChildWithDb(
	db: SqliteDatabase,
	input: CreateFailedMultiAgentChildInput,
	agent: AgentSnapshot & Record<string, unknown>,
	parentId: string,
	serializedAgent: string,
): CreateFailedMultiAgentChildResult {
	for (let attempt = 1; attempt <= MULTI_AGENT_CREATION_MAX_ATTEMPTS; attempt += 1) {
		const parent = readActiveParentSnapshot(db, input.sessionPath, parentId);
		if (!parent) return { ok: false, error: "parent_not_found" };
		if (multiAgentAgentExists(db, input.sessionPath, agent.id)) return { ok: false, error: "agent_exists" };
		const result = commitFailedMultiAgentChild(db, input, agent, serializedAgent, parent);
		if (result) return result;
	}
	throw new Error(`Failed child parent changed repeatedly ${input.sessionPath}#${agent.id}`);
}

export function commitFailedMultiAgentChild(
	db: SqliteDatabase,
	input: CreateFailedMultiAgentChildInput,
	agent: AgentSnapshot & Record<string, unknown>,
	serializedAgent: string,
	parent: ActiveParentSnapshot,
): CreateFailedMultiAgentChildResult | undefined {
	return withImmediateTransaction(db, () => {
		if (
			!insertMultiAgentAgentIfParentCurrent(db, input.sessionPath, agent.id, serializedAgent, input.nowIso, parent)
		) {
			return undefined;
		}
		db.prepare(
			`INSERT INTO multi_agent_terminal_outbox (
				session_path, agent_id, terminal_revision, event_kind, status,
				claim_id, claimed_at, attempt_count, last_error, updated_at
			) VALUES (?, ?, 1, 'failed', 'pending', NULL, NULL, 0, NULL, ?)`,
		).run(input.sessionPath, agent.id, input.nowIso);
		return { ok: true, agent };
	});
}

export function readActiveParentSnapshot(
	db: SqliteDatabase,
	sessionPath: string,
	parentId: string,
): ActiveParentSnapshot | undefined {
	if (parentId === "main") return { parentId };
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, parentId) as { data: string } | undefined;
	if (!row) return undefined;
	const context = `multi_agent_agents:${sessionPath}#${parentId}`;
	const parent = parseStoredJsonObject(row.data, context);
	validatePersistedAgentPayload(parent, context);
	if (!isNonterminalLifecycle(parent.lifecycle)) return undefined;
	return { agent: parent as unknown as AgentSnapshot, data: row.data, parentId };
}

export function multiAgentAgentExists(db: SqliteDatabase, sessionPath: string, agentId: string): boolean {
	return Boolean(
		db.prepare("SELECT 1 FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?").get(sessionPath, agentId),
	);
}

export function insertMultiAgentAgentIfParentCurrent(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
	serializedAgent: string,
	updatedAt: string,
	parent: ActiveParentSnapshot,
): boolean {
	return (
		db
			.prepare(
				`INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at)
				 SELECT ?, ?, ?, ?
				 WHERE (? = 'main' OR EXISTS (
					SELECT 1 FROM multi_agent_agents
					WHERE session_path = ? AND agent_id = ? AND data = ?
				 ))
				 ON CONFLICT(session_path, agent_id) DO NOTHING`,
			)
			.run(
				sessionPath,
				agentId,
				serializedAgent,
				updatedAt,
				parent.parentId,
				sessionPath,
				parent.parentId,
				parent.data ?? null,
			).changes === 1
	);
}

export function createMultiAgentChildWithRuntimeOwnership(
	controlDbPath: string,
	input: CreateMultiAgentChildWithRuntimeOwnershipInput,
): CreateMultiAgentChildWithRuntimeOwnershipResult {
	const agent = input.agent as Record<string, unknown>;
	validatePersistedAgentPayload(agent, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
	if (agent.id !== input.agentId) throw new Error("Child agent payload ID does not match runtime ownership identity");
	if (agent.lifecycle !== "running" || agent.revision !== 1) {
		throw new Error("Child runtime ownership requires running revision 1");
	}
	const parentId = typeof agent.parentId === "string" ? agent.parentId : undefined;
	if (!parentId) return { ok: false, error: "parent_not_found" };
	const processIdentityData = serializeProcessIdentity(input.processIdentity);
	const serializedAgent = JSON.stringify(input.agent);
	return withControlDb(controlDbPath, (db) =>
		createMultiAgentChildWithRuntimeOwnershipWithDb(db, input, parentId, processIdentityData, serializedAgent),
	);
}

export function createMultiAgentChildWithRuntimeOwnershipWithDb(
	db: SqliteDatabase,
	input: CreateMultiAgentChildWithRuntimeOwnershipInput,
	parentId: string,
	processIdentityData: string,
	serializedAgent: string,
): CreateMultiAgentChildWithRuntimeOwnershipResult {
	for (let attempt = 1; attempt <= MULTI_AGENT_CREATION_MAX_ATTEMPTS; attempt += 1) {
		const parent = readActiveParentSnapshot(db, input.sessionPath, parentId);
		if (!parent) return { ok: false, error: "parent_not_found" };
		if (multiAgentAgentExists(db, input.sessionPath, input.agentId)) return { ok: false, error: "agent_exists" };
		const result = commitMultiAgentChildWithRuntimeOwnership(db, input, processIdentityData, serializedAgent, parent);
		if (result) return result;
	}
	throw new Error(`Child parent changed repeatedly ${input.sessionPath}#${input.agentId}`);
}

export function commitMultiAgentChildWithRuntimeOwnership(
	db: SqliteDatabase,
	input: CreateMultiAgentChildWithRuntimeOwnershipInput,
	processIdentityData: string,
	serializedAgent: string,
	parent: ActiveParentSnapshot,
): CreateMultiAgentChildWithRuntimeOwnershipResult | undefined {
	return withImmediateTransaction(db, () => {
		if (
			!insertMultiAgentAgentIfParentCurrent(
				db,
				input.sessionPath,
				input.agentId,
				serializedAgent,
				input.nowIso,
				parent,
			)
		) {
			return undefined;
		}
		persistAcquiredRuntimeOwnership(db, input, processIdentityData);
		return { agent: input.agent, ok: true, ownership: multiAgentRuntimeOwnershipFromInput(input) };
	});
}

export function persistAcquiredRuntimeOwnership(
	db: SqliteDatabase,
	input: MultiAgentRuntimeOwnershipIdentity,
	processIdentityData: string,
): void {
	db.prepare(
		`INSERT INTO multi_agent_runtime_owners (
			session_path, agent_id, process_identity, owner_session_id, owner_agent_id
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(session_path, agent_id) DO UPDATE SET
			process_identity = excluded.process_identity,
			owner_session_id = excluded.owner_session_id,
			owner_agent_id = excluded.owner_agent_id`,
	).run(input.sessionPath, input.agentId, processIdentityData, input.owner.sessionId, input.owner.agentId);
}

export function multiAgentRuntimeOwnershipFromInput(
	input: MultiAgentRuntimeOwnershipIdentity,
): MultiAgentRuntimeOwnership {
	return {
		agentId: input.agentId,
		owner: input.owner,
		processIdentity: input.processIdentity,
		sessionPath: input.sessionPath,
	};
}
