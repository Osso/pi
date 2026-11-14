import { type AgentSnapshot, isActiveLifecycle } from "../multi-agent-store.ts";
import { isProcessIdentityAlive, isSupersededRuntimeIdentity } from "../runtime-process.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { parseStoredJsonObject, validatePersistedAgentPayload } from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import {
	type MultiAgentRuntimeOwnershipIdentity,
	runtimeOwnerMatches,
	serializeProcessIdentity,
} from "./detached-job-finalization.ts";
import { isRecoverableRuntimeLifecycle, type SupervisorRuntimeOwnership } from "./detached-job-recovery.ts";
import { parseProcessIdentity, withImmediateTransaction } from "./helpers.ts";
import {
	type ActiveParentSnapshot,
	insertMultiAgentAgentIfParentCurrent,
	MULTI_AGENT_CREATION_MAX_ATTEMPTS,
	type MultiAgentRuntimeOwnership,
	multiAgentAgentExists,
	multiAgentRuntimeOwnershipFromInput,
	persistAcquiredRuntimeOwnership,
	readActiveParentSnapshot,
} from "./multi-agent-child-creation.ts";
import {
	type MultiAgentRuntimeOwnershipRow,
	multiAgentRuntimeOwnershipRowsEqual,
	readMultiAgentRuntimeOwnershipRow,
} from "./runtime-mailbox-enqueue.ts";

export interface CreateMultiAgentAttachmentInput {
	agent: AgentSnapshot;
	agentId: string;
	nowIso: string;
	sessionPath: string;
}

export type CreateMultiAgentAttachmentResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_exists" | "parent_not_found" | "permission_broadened" };

export interface AcquireAttachedRuntimeOwnershipInput extends MultiAgentRuntimeOwnershipIdentity {
	nowIso: string;
	supervisor: SupervisorRuntimeOwnership;
}

export type AcquireAttachedRuntimeOwnershipResult =
	| { ok: true; agent: AgentSnapshot; ownership: MultiAgentRuntimeOwnership }
	| { ok: false; error: "agent_not_found" | "invalid_agent" | "ownership_held" | "mutation_mismatch" };

export function createMultiAgentAttachment(
	controlDbPath: string,
	input: CreateMultiAgentAttachmentInput,
): CreateMultiAgentAttachmentResult {
	const agent = input.agent as AgentSnapshot & Record<string, unknown>;
	validatePersistedAgentPayload(agent, `multi_agent_agents:${input.sessionPath}#${input.agentId}`);
	if (agent.id !== input.agentId) throw new Error("Attached agent payload ID does not match command identity");
	if (agent.origin !== "attached" || agent.lifecycle !== "waiting_for_input" || agent.revision !== 1) {
		throw new Error("Attached agent creation requires waiting_for_input revision 1");
	}
	const serializedAgent = JSON.stringify(agent);
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_CREATION_MAX_ATTEMPTS; attempt += 1) {
			if (multiAgentAgentExists(db, input.sessionPath, input.agentId)) return { ok: false, error: "agent_exists" };
			const parent = readAttachmentParentSnapshot(db, input.sessionPath, agent);
			if ("error" in parent) return { ok: false, error: parent.error };
			if (
				insertMultiAgentAgentIfParentCurrent(
					db,
					input.sessionPath,
					input.agentId,
					serializedAgent,
					input.nowIso,
					parent,
				)
			) {
				return { ok: true, agent: input.agent };
			}
		}
		throw new Error(`Attachment parent changed repeatedly ${input.sessionPath}#${input.agentId}`);
	});
}

export function readAttachmentParentSnapshot(
	db: SqliteDatabase,
	sessionPath: string,
	agent: AgentSnapshot & Record<string, unknown>,
): ActiveParentSnapshot | { error: "parent_not_found" | "permission_broadened" } {
	const parentId = agent.parentId;
	if (!parentId || parentId === "main") return { parentId: "main" };
	const parent = readActiveParentSnapshot(db, sessionPath, parentId);
	if (!parent?.agent) return { error: "parent_not_found" };
	const parentPermission = parent.agent.permission;
	const permissionMatches = agent.permission.narrowed && agent.permission.policy === parentPermission.policy;
	return permissionMatches ? parent : { error: "permission_broadened" };
}

export function readMultiAgentRuntimeOwnership(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
): MultiAgentRuntimeOwnership | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = readMultiAgentRuntimeOwnershipRow(db, sessionPath, agentId);
		return row ? multiAgentRuntimeOwnershipFromRow(row) : undefined;
	});
}

export const ATTACHED_RUNTIME_OWNERSHIP_MAX_ATTEMPTS = 3;

export type SupervisorSessionAuthoritySnapshot = {
	listener: {
		runtime_instance_id: string;
		session_path: string | null;
		session_path_asserted_at: string | null;
	};
	supervisorAgentData?: string;
};

export type AcquireAttachedRuntimeOwnershipPlan = {
	agentData: string;
	ownership: MultiAgentRuntimeOwnershipRow | undefined;
	processIdentityData: string;
	supervisorAuthority: SupervisorSessionAuthoritySnapshot;
	updatedAgent: Record<string, unknown>;
	updatedAgentData: string;
};

export type AcquireAttachedRuntimeOwnershipPreflight =
	| { plan: AcquireAttachedRuntimeOwnershipPlan }
	| { result: AcquireAttachedRuntimeOwnershipResult };

export type AttachedRuntimeAgentRead =
	| { agent: Record<string, unknown>; data: string; ok: true }
	| { error: "agent_not_found" | "invalid_agent"; ok: false };

export function acquireAttachedRuntimeOwnership(
	controlDbPath: string,
	input: AcquireAttachedRuntimeOwnershipInput,
): AcquireAttachedRuntimeOwnershipResult {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= ATTACHED_RUNTIME_OWNERSHIP_MAX_ATTEMPTS; attempt += 1) {
			const preflight = prepareAttachedRuntimeOwnershipAcquisition(db, input);
			if ("result" in preflight) return preflight.result;
			const result = commitAttachedRuntimeOwnershipAcquisition(db, input, preflight.plan);
			if (result) return result;
		}
		return { ok: false, error: "mutation_mismatch" };
	});
}

export function prepareAttachedRuntimeOwnershipAcquisition(
	db: SqliteDatabase,
	input: AcquireAttachedRuntimeOwnershipInput,
): AcquireAttachedRuntimeOwnershipPreflight {
	const supervisorAuthority = readRegisteredSupervisorSessionAuthority(db, input.sessionPath, input.supervisor);
	if (!supervisorAuthority) return { result: { ok: false, error: "mutation_mismatch" } };
	const agentRead = readAttachedRuntimeAgent(db, input.sessionPath, input.agentId);
	if (!agentRead.ok) return { result: agentRead };
	const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
	const currentIdentity = ownership?.process_identity ? parseProcessIdentity(ownership.process_identity) : undefined;
	const currentOwnerAlive = currentIdentity !== undefined && isProcessIdentityAlive(currentIdentity);
	if (ownership && currentOwnerAlive && runtimeOwnerMatches(ownership, input)) {
		return {
			result: {
				agent: agentRead.agent as unknown as AgentSnapshot,
				ok: true,
				ownership: multiAgentRuntimeOwnershipFromRow(ownership),
			},
		};
	}
	const replacesCurrentIncarnation =
		currentIdentity !== undefined && isSupersededRuntimeIdentity(currentIdentity, input.processIdentity);
	if (currentOwnerAlive && !replacesCurrentIncarnation) {
		return { result: { ok: false, error: "ownership_held" } };
	}
	const updatedAgent = {
		...agentRead.agent,
		revision: Number(agentRead.agent.revision) + 1,
		updatedAt: input.nowIso,
	};
	return {
		plan: {
			agentData: agentRead.data,
			ownership,
			processIdentityData: serializeProcessIdentity(input.processIdentity),
			supervisorAuthority,
			updatedAgent,
			updatedAgentData: JSON.stringify(updatedAgent),
		},
	};
}

export function readAttachedRuntimeAgent(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
): AttachedRuntimeAgentRead {
	const row = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, agentId) as { data: string } | undefined;
	if (!row) return { ok: false, error: "agent_not_found" };
	const context = `multi_agent_agents:${sessionPath}#${agentId}`;
	const agent = parseStoredJsonObject(row.data, context);
	validatePersistedAgentPayload(agent, context);
	if (!isRecoverableRuntimeLifecycle(agent.lifecycle)) return { ok: false, error: "invalid_agent" };
	return { agent, data: row.data, ok: true };
}

export function commitAttachedRuntimeOwnershipAcquisition(
	db: SqliteDatabase,
	input: AcquireAttachedRuntimeOwnershipInput,
	plan: AcquireAttachedRuntimeOwnershipPlan,
): AcquireAttachedRuntimeOwnershipResult | undefined {
	const persisted = withImmediateTransaction(db, () => {
		if (!supervisorSessionAuthorityIsCurrent(db, input.sessionPath, input.supervisor, plan.supervisorAuthority)) {
			return { ok: false, error: "mutation_mismatch" } as const;
		}
		const row = db
			.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
			.get(input.sessionPath, input.agentId) as { data: string } | undefined;
		if (!row) return { ok: false, error: "agent_not_found" } as const;
		if (row.data !== plan.agentData) return undefined;
		const ownership = readMultiAgentRuntimeOwnershipRow(db, input.sessionPath, input.agentId);
		if (!multiAgentRuntimeOwnershipRowsEqual(plan.ownership, ownership)) return undefined;
		persistAttachedRuntimeOwnershipAcquisition(db, input, plan);
		return true;
	});
	if (persisted !== true) return persisted;
	return {
		agent: plan.updatedAgent as unknown as AgentSnapshot,
		ok: true,
		ownership: multiAgentRuntimeOwnershipFromInput(input),
	};
}

export function persistAttachedRuntimeOwnershipAcquisition(
	db: SqliteDatabase,
	input: AcquireAttachedRuntimeOwnershipInput,
	plan: AcquireAttachedRuntimeOwnershipPlan,
): void {
	persistAcquiredRuntimeOwnership(db, input, plan.processIdentityData);
	db.prepare("UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?").run(
		plan.updatedAgentData,
		input.nowIso,
		input.sessionPath,
		input.agentId,
	);
}

export function readRegisteredSupervisorSessionAuthority(
	db: SqliteDatabase,
	sessionPath: string,
	supervisor: SupervisorRuntimeOwnership,
): SupervisorSessionAuthoritySnapshot | undefined {
	if (!isProcessIdentityAlive(supervisor.processIdentity)) return undefined;
	const authority = readPersistedSupervisorSessionAuthority(db, sessionPath, supervisor);
	if (!authority) return undefined;
	try {
		const listenerIdentity = serializeProcessIdentity(parseProcessIdentity(authority.listener.runtime_instance_id));
		return listenerIdentity === serializeProcessIdentity(supervisor.processIdentity) ? authority : undefined;
	} catch {
		return undefined;
	}
}

export function readPersistedSupervisorSessionAuthority(
	db: SqliteDatabase,
	sessionPath: string,
	supervisor: SupervisorRuntimeOwnership,
): SupervisorSessionAuthoritySnapshot | undefined {
	const listener = db
		.prepare(
			`SELECT runtime_instance_id, session_path, session_path_asserted_at
			 FROM runtime_mailbox_listeners
			 WHERE recipient_session_id = ? AND recipient_agent_id_key = ? AND pid = ?`,
		)
		.get(supervisor.sessionId, supervisor.agentId ?? "", supervisor.processIdentity.pid) as
		| {
				runtime_instance_id: string | null;
				session_path: string | null;
				session_path_asserted_at: string | null;
		  }
		| undefined;
	if (!listener?.runtime_instance_id) return undefined;
	if (!supervisor.agentId) {
		if (listener.session_path !== sessionPath || listener.session_path_asserted_at === null) return undefined;
		return { listener: { ...listener, runtime_instance_id: listener.runtime_instance_id } };
	}
	const supervisorAgent = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, supervisor.agentId) as { data: string } | undefined;
	if (!supervisorAgent) return undefined;
	const snapshot = parseStoredJsonObject(
		supervisorAgent.data,
		`multi_agent_agents:${sessionPath}#${supervisor.agentId}`,
	) as unknown as AgentSnapshot;
	if (snapshot.transcript?.sessionId !== supervisor.sessionId || !isActiveLifecycle(snapshot.lifecycle)) {
		return undefined;
	}
	return {
		listener: { ...listener, runtime_instance_id: listener.runtime_instance_id },
		supervisorAgentData: supervisorAgent.data,
	};
}

export function supervisorSessionAuthorityIsCurrent(
	db: SqliteDatabase,
	sessionPath: string,
	supervisor: SupervisorRuntimeOwnership,
	expected: SupervisorSessionAuthoritySnapshot,
): boolean {
	const listener = db
		.prepare(
			`SELECT runtime_instance_id, session_path, session_path_asserted_at
			 FROM runtime_mailbox_listeners
			 WHERE recipient_session_id = ? AND recipient_agent_id_key = ? AND pid = ?`,
		)
		.get(supervisor.sessionId, supervisor.agentId ?? "", supervisor.processIdentity.pid) as
		| SupervisorSessionAuthoritySnapshot["listener"]
		| undefined;
	if (
		!listener ||
		listener.runtime_instance_id !== expected.listener.runtime_instance_id ||
		listener.session_path !== expected.listener.session_path ||
		listener.session_path_asserted_at !== expected.listener.session_path_asserted_at
	) {
		return false;
	}
	if (!supervisor.agentId) return expected.supervisorAgentData === undefined;
	const supervisorAgent = db
		.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
		.get(sessionPath, supervisor.agentId) as { data: string } | undefined;
	return supervisorAgent?.data === expected.supervisorAgentData;
}

export function multiAgentRuntimeOwnershipFromRow(row: MultiAgentRuntimeOwnershipRow): MultiAgentRuntimeOwnership {
	return {
		agentId: row.agent_id,
		owner: { agentId: row.owner_agent_id, sessionId: row.owner_session_id ?? undefined },
		processIdentity: row.process_identity
			? parseProcessIdentity(row.process_identity, `multi_agent_runtime_owners:${row.session_path}#${row.agent_id}`)
			: undefined,
		sessionPath: row.session_path,
	};
}
