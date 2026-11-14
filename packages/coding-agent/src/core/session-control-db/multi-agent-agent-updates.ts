import type { AgentSnapshot } from "../multi-agent-store.ts";
import type { ProcessIdentity } from "../runtime-process.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { parseStoredJsonObject, validatePersistedAgentPayload } from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import { serializeProcessIdentity } from "./detached-job-finalization.ts";
import { readMultiAgentRuntimeOwnershipRow } from "./runtime-mailbox-enqueue.ts";

export function updateMultiAgentAgentActivity(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	lastActivity: AgentSnapshot["lastActivity"],
	updatedAt: string,
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(controlDbPath, sessionPath, agentId, { lastActivity }, updatedAt);
}

export function updateMultiAgentAgentCurrentActivity(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	currentActivity: AgentSnapshot["currentActivity"],
	updatedAt: string,
	ownership: { ownerSessionId: string; processIdentity: ProcessIdentity },
	model?: NonNullable<AgentSnapshot["model"]>,
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(
		controlDbPath,
		sessionPath,
		agentId,
		{ currentActivity, ...(model ? { model } : {}) },
		updatedAt,
		ownership,
	);
}

export function updateMultiAgentAgentModel(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	model: NonNullable<AgentSnapshot["model"]>,
	updatedAt: string,
	ownership: { ownerSessionId: string; processIdentity: ProcessIdentity },
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(controlDbPath, sessionPath, agentId, { model }, updatedAt, ownership);
}

export function updateMultiAgentAgentDisplayName(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	displayName: string,
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(controlDbPath, sessionPath, agentId, { displayName }, undefined);
}

export function updateMultiAgentAgentSlot(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	slot: AgentSnapshot["slot"],
	updatedAt: string,
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(controlDbPath, sessionPath, agentId, { slot }, updatedAt);
}

export function updateMultiAgentAgentTranscript(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	transcript: AgentSnapshot["transcript"],
	updatedAt: string,
): AgentSnapshot | undefined {
	return updateMultiAgentAgentMetadata(controlDbPath, sessionPath, agentId, { transcript }, updatedAt);
}

export function multiAgentActivityOwnershipMatches(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
	ownership: { ownerSessionId: string; processIdentity: ProcessIdentity },
): boolean {
	const runtimeOwnership = readMultiAgentRuntimeOwnershipRow(db, sessionPath, agentId);
	return (
		runtimeOwnership?.owner_session_id === ownership.ownerSessionId &&
		runtimeOwnership.owner_agent_id === null &&
		runtimeOwnership.process_identity === serializeProcessIdentity(ownership.processIdentity)
	);
}

export type MultiAgentAgentMetadata =
	| Pick<AgentSnapshot, "displayName">
	| (Pick<AgentSnapshot, "currentActivity"> & Partial<Pick<AgentSnapshot, "model">>)
	| Pick<AgentSnapshot, "model">
	| Pick<AgentSnapshot, "lastActivity">
	| Pick<AgentSnapshot, "slot">
	| Pick<AgentSnapshot, "transcript">;

export function permitsMultiAgentCurrentActivity(
	agent: Record<string, unknown>,
	metadata: MultiAgentAgentMetadata,
): boolean {
	return (
		!("currentActivity" in metadata) ||
		metadata.currentActivity === undefined ||
		agent.lifecycle === "running" ||
		agent.lifecycle === "steering_pending"
	);
}

export const MULTI_AGENT_METADATA_UPDATE_MAX_ATTEMPTS = 3;

export type MultiAgentAgentMetadataRow = {
	data: string;
	updated_at: string;
};

export function updateMultiAgentAgentMetadata(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
	metadata: MultiAgentAgentMetadata,
	updatedAt: string | undefined,
	activityOwnership?: { ownerSessionId: string; processIdentity: ProcessIdentity },
): AgentSnapshot | undefined {
	return withControlDb(controlDbPath, (db) => {
		for (let attempt = 1; attempt <= MULTI_AGENT_METADATA_UPDATE_MAX_ATTEMPTS; attempt += 1) {
			const row = db
				.prepare("SELECT data, updated_at FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
				.get(sessionPath, agentId) as MultiAgentAgentMetadataRow | undefined;
			if (!row) return undefined;
			const context = `multi_agent_agents:${sessionPath}#${agentId}`;
			const agent = parseStoredJsonObject(row.data, context);
			validatePersistedAgentPayload(agent, context);
			if (activityOwnership && !multiAgentActivityOwnershipMatches(db, sessionPath, agentId, activityOwnership)) {
				return undefined;
			}
			if (!permitsMultiAgentCurrentActivity(agent, metadata)) return undefined;
			const updated = { ...agent, ...metadata, updatedAt: updatedAt ?? agent.updatedAt } as AgentSnapshot;
			if (compareAndUpdateMultiAgentAgentMetadata(db, sessionPath, agentId, row, updated, activityOwnership)) {
				return updated;
			}
		}
		throw new Error(`Multi-agent metadata changed repeatedly while updating ${sessionPath}#${agentId}`);
	});
}

export type MultiAgentMetadataWrite = {
	agentId: string;
	previous: MultiAgentAgentMetadataRow;
	serialized: string;
	sessionPath: string;
	updatedAt: string;
};

export function compareAndUpdateMultiAgentAgentMetadata(
	db: SqliteDatabase,
	sessionPath: string,
	agentId: string,
	row: MultiAgentAgentMetadataRow,
	updated: AgentSnapshot,
	activityOwnership?: { ownerSessionId: string; processIdentity: ProcessIdentity },
): boolean {
	const write: MultiAgentMetadataWrite = {
		agentId,
		previous: row,
		serialized: JSON.stringify(updated),
		sessionPath,
		updatedAt: updated.updatedAt,
	};
	return activityOwnership
		? compareAndUpdateOwnedMultiAgentMetadata(db, write, activityOwnership)
		: compareAndUpdateMultiAgentMetadataSnapshot(db, write);
}

export function compareAndUpdateMultiAgentMetadataSnapshot(
	db: SqliteDatabase,
	write: MultiAgentMetadataWrite,
): boolean {
	return (
		db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ? AND updated_at = ?`,
			)
			.run(
				write.serialized,
				write.updatedAt,
				write.sessionPath,
				write.agentId,
				write.previous.data,
				write.previous.updated_at,
			).changes === 1
	);
}

export function compareAndUpdateOwnedMultiAgentMetadata(
	db: SqliteDatabase,
	write: MultiAgentMetadataWrite,
	ownership: { ownerSessionId: string; processIdentity: ProcessIdentity },
): boolean {
	return (
		db
			.prepare(
				`UPDATE multi_agent_agents SET data = ?, updated_at = ?
				 WHERE session_path = ? AND agent_id = ? AND data = ? AND updated_at = ?
				 AND EXISTS (
					SELECT 1 FROM multi_agent_runtime_owners
					WHERE session_path = ? AND agent_id = ? AND owner_session_id = ?
					AND owner_agent_id IS NULL AND process_identity = ?
				 )`,
			)
			.run(
				write.serialized,
				write.updatedAt,
				write.sessionPath,
				write.agentId,
				write.previous.data,
				write.previous.updated_at,
				write.sessionPath,
				write.agentId,
				ownership.ownerSessionId,
				serializeProcessIdentity(ownership.processIdentity),
			).changes === 1
	);
}
