import { MAILBOX_MESSAGE_RETENTION_MS } from "../mailbox-retention.ts";
import type { AgentSnapshot } from "../multi-agent-store.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { parseStoredJsonObject, validateMailboxPayload, validatePersistedAgentPayload } from "./codecs.ts";
import { TERMINAL_AGENT_ROW_TABLES, withImmediateTransaction } from "./helpers.ts";
import { MAILBOX_CREATED_AT_MS_SQL } from "./types.ts";

export interface MultiAgentCounters {
	nextAgentNumber: number;
	nextMessageNumber: number;
}

import { withControlDb } from "./connection.ts";

export interface MultiAgentPersistedState {
	agents: unknown[];
	mailboxMessages: unknown[];
	counters: MultiAgentCounters;
}

export function writeMultiAgentCounters(
	controlDbPath: string,
	sessionPath: string,
	counters: MultiAgentCounters,
): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			INSERT INTO multi_agent_counters_v2 (
				session_path, next_agent_number, next_message_number, updated_at
			)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(session_path) DO UPDATE SET
				next_agent_number = excluded.next_agent_number,
				next_message_number = excluded.next_message_number,
				updated_at = excluded.updated_at
			`,
		).run(sessionPath, counters.nextAgentNumber, counters.nextMessageNumber, new Date().toISOString());
	});
}

export type MultiAgentCounterName = "agent" | "message";

export const MULTI_AGENT_COUNTER_ALLOCATION_SQL: Record<MultiAgentCounterName, string> = {
	agent: `INSERT INTO multi_agent_counters_v2
		(session_path, next_agent_number, next_message_number, updated_at)
		VALUES (?, 2, 1, ?)
		ON CONFLICT(session_path) DO UPDATE SET
			next_agent_number = next_agent_number + 1,
			updated_at = excluded.updated_at
		RETURNING next_agent_number - 1 AS value`,
	message: `INSERT INTO multi_agent_counters_v2
		(session_path, next_agent_number, next_message_number, updated_at)
		VALUES (?, 1, 2, ?)
		ON CONFLICT(session_path) DO UPDATE SET
			next_message_number = next_message_number + 1,
			updated_at = excluded.updated_at
		RETURNING next_message_number - 1 AS value`,
};

export function allocateMultiAgentCounter(
	controlDbPath: string,
	sessionPath: string,
	counterName: MultiAgentCounterName,
): number {
	return withControlDb(controlDbPath, (db) => allocateMultiAgentCounterWithDb(db, sessionPath, counterName));
}

export function allocateMultiAgentCounterWithDb(
	db: SqliteDatabase,
	sessionPath: string,
	counterName: MultiAgentCounterName,
): number {
	const row = db.prepare(MULTI_AGENT_COUNTER_ALLOCATION_SQL[counterName]).get(sessionPath, new Date().toISOString()) as
		| { value: number }
		| undefined;
	if (!row) throw new Error(`Multi-agent ${counterName} counter allocation returned no value for ${sessionPath}`);
	return row.value;
}

export function readMultiAgentAgent(
	controlDbPath: string,
	sessionPath: string,
	agentId: string,
): AgentSnapshot | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?")
			.get(sessionPath, agentId) as { data: string } | undefined;
		if (!row) return undefined;
		const context = `multi_agent_agents:${sessionPath}#${agentId}`;
		const agent = parseStoredJsonObject(row.data, context);
		validatePersistedAgentPayload(agent, context);
		return agent as unknown as AgentSnapshot;
	});
}

export function readMultiAgentAgents(
	controlDbPath: string,
	sessionPath: string,
	agentIds: readonly string[],
): AgentSnapshot[] {
	return withControlDb(controlDbPath, (db) => {
		const readAgent = db.prepare("SELECT data FROM multi_agent_agents WHERE session_path = ? AND agent_id = ?");
		return agentIds.flatMap((agentId) => {
			const row = readAgent.get(sessionPath, agentId) as { data: string } | undefined;
			if (!row) return [];
			const context = `multi_agent_agents:${sessionPath}#${agentId}`;
			const agent = parseStoredJsonObject(row.data, context);
			validatePersistedAgentPayload(agent, context);
			return [agent as unknown as AgentSnapshot];
		});
	});
}

/** Non-terminal agents for a session; terminal history stays in SQLite. */

export function readActiveMultiAgentAgents(controlDbPath: string, sessionPath: string): AgentSnapshot[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`SELECT agent_id, data FROM multi_agent_agents
				 WHERE session_path = ?
				   AND (NOT json_valid(data) OR json_extract(data, '$.lifecycle') NOT IN ('completed', 'failed', 'aborted'))
				 ORDER BY rowid`,
			)
			.all(sessionPath) as Array<{ agent_id: string; data: string }>;
		return rows.map((row) => {
			const context = `multi_agent_agents:${sessionPath}#${row.agent_id}`;
			const agent = parseStoredJsonObject(row.data, context);
			validatePersistedAgentPayload(agent, context);
			return agent as unknown as AgentSnapshot;
		});
	});
}

export interface MultiAgentAgentKey {
	sessionPath: string;
	agentId: string;
}

/**
 * Deletes terminal agent rows whose detached output was removed, with their runtime-owner and
 * terminal-outbox rows. Rows that became non-terminal, have an undelivered terminal outbox row,
 * or parent a non-terminal agent are kept. Returns the number of deleted agent rows.
 */

export function deleteReleasedTerminalMultiAgentAgents(
	controlDbPath: string,
	keys: readonly MultiAgentAgentKey[],
): number {
	if (keys.length === 0) return 0;
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const activeParents = new Set(
				(db.prepare(ACTIVE_PARENT_KEYS_SQL).all() as Array<{ key: string }>).map((row) => row.key),
			);
			const releasable = db.prepare(RELEASABLE_TERMINAL_AGENT_SQL);
			const deleteRows = TERMINAL_AGENT_ROW_TABLES.map((table) =>
				db.prepare(`DELETE FROM ${table} WHERE session_path = ? AND agent_id = ?`),
			);
			let deleted = 0;
			for (const { agentId, sessionPath } of keys) {
				if (activeParents.has(`${sessionPath}\0${agentId}`) || !releasable.get(sessionPath, agentId)) continue;
				for (const statement of deleteRows) statement.run(sessionPath, agentId);
				deleted += 1;
			}
			return deleted;
		}),
	);
}

export const ACTIVE_PARENT_KEYS_SQL = `SELECT DISTINCT session_path || char(0) || json_extract(data, '$.parentId') AS key
	FROM multi_agent_agents
	WHERE json_valid(data) AND json_extract(data, '$.parentId') IS NOT NULL
		AND json_extract(data, '$.lifecycle') NOT IN ('completed', 'failed', 'aborted')`;

export const RELEASABLE_TERMINAL_AGENT_SQL = `SELECT 1 FROM multi_agent_agents AS agent
	WHERE agent.session_path = ? AND agent.agent_id = ? AND json_valid(agent.data)
		AND json_extract(agent.data, '$.lifecycle') IN ('completed', 'failed', 'aborted')
		AND NOT EXISTS (
			SELECT 1 FROM multi_agent_terminal_outbox AS outbox
			WHERE outbox.session_path = agent.session_path AND outbox.agent_id = agent.agent_id
				AND outbox.delivered_at IS NULL
		)`;

export function readPersistedMultiAgentRows(
	db: SqliteDatabase,
	table: "multi_agent_agents" | "multi_agent_mailbox_messages",
	sessionPath: string,
): unknown[] {
	const mailbox = table === "multi_agent_mailbox_messages";
	const rows = db
		.prepare(`SELECT data FROM ${table} WHERE session_path = ?
		${mailbox ? `AND ${MAILBOX_CREATED_AT_MS_SQL} > ?` : ""} ORDER BY rowid`)
		.all(sessionPath, ...(mailbox ? [Date.now() - MAILBOX_MESSAGE_RETENTION_MS] : [])) as Array<{ data: string }>;
	return rows.map((row, index) => {
		const context = `${table}:${sessionPath}[${index}]`;
		const data = parseStoredJsonObject(row.data, context);
		if (mailbox) validateMailboxPayload(data, context);
		else validatePersistedAgentPayload(data, context);
		return data;
	});
}

export function readMultiAgentState(controlDbPath: string, sessionPath: string): MultiAgentPersistedState | undefined {
	return withControlDb(controlDbPath, (db) => {
		const counters = db
			.prepare(
				`
				SELECT next_agent_number, next_message_number
				FROM multi_agent_counters_v2 WHERE session_path = ?
				`,
			)
			.get(sessionPath) as { next_agent_number: number; next_message_number: number } | undefined;
		const agents = readPersistedMultiAgentRows(db, "multi_agent_agents", sessionPath);
		const mailboxMessages = readPersistedMultiAgentRows(db, "multi_agent_mailbox_messages", sessionPath);
		if (!counters && agents.length === 0 && mailboxMessages.length === 0) {
			return undefined;
		}
		return {
			agents,
			mailboxMessages,
			counters: {
				nextAgentNumber: counters?.next_agent_number ?? 1,
				nextMessageNumber: counters?.next_message_number ?? 1,
			},
		};
	});
}
