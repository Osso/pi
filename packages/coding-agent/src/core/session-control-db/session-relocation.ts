import type { SqliteDatabase } from "../sqlite.ts";
import { withControlDb } from "./connection.ts";
import { normalizeSessionName, withImmediateTransaction } from "./helpers.ts";

export interface SessionNameState {
	name: string | undefined;
	hasStoredValue: boolean;
}

export type SessionNameWriteResult = SessionNameState & {
	written: boolean;
	revision: number | null;
};

type SessionNameWriteRow = {
	name: string | null;
	name_revision: number;
};

export function writeSessionName(
	controlDbPath: string,
	sessionPath: string,
	name: string | undefined,
	expectedRevision?: number | null,
): SessionNameWriteResult {
	const storedName = normalizeSessionName(name) ?? "";
	const unconditional = expectedRevision === undefined;
	const revision = expectedRevision ?? null;
	return withControlDb(controlDbPath, (db) => {
		const updated = db
			.prepare(
				`UPDATE session_metadata
				 SET name = ?, name_revision = name_revision + 1, updated_at = ?
				 WHERE session_path = ? AND (? OR (? IS NULL AND name IS NULL) OR name_revision = ?)
				 RETURNING name, name_revision`,
			)
			.get(storedName, new Date().toISOString(), sessionPath, Number(unconditional), revision, revision) as
			| SessionNameWriteRow
			| undefined;
		if (updated) return sessionNameWriteResult(updated, true);

		const current = db
			.prepare("SELECT name, name_revision FROM session_metadata WHERE session_path = ?")
			.get(sessionPath) as SessionNameWriteRow | undefined;
		if (!current) throw new Error(`Cannot update session name without metadata for ${sessionPath}`);
		return sessionNameWriteResult(current, false);
	});
}

function sessionNameWriteResult(row: SessionNameWriteRow, written: boolean): SessionNameWriteResult {
	return {
		name: normalizeSessionName(row.name ?? undefined),
		hasStoredValue: row.name !== null,
		written,
		revision: row.name_revision,
	};
}

export function readSessionNameState(controlDbPath: string, sessionPath: string): SessionNameState {
	return withControlDb(controlDbPath, (db) => {
		const row = db.prepare("SELECT name FROM session_metadata WHERE session_path = ?").get(sessionPath) as
			| { name: string | null }
			| undefined;
		if (!row || row.name === null) return { name: undefined, hasStoredValue: false };
		return { name: normalizeSessionName(row.name), hasStoredValue: true };
	});
}

/** Lists child agent sessions recorded under a parent, matching its plain and archived transcript paths. */

export function listSubagentSessionPaths(controlDbPath: string, parentSessionPath: string): string[] {
	const plainPath = parentSessionPath.endsWith(".zst")
		? parentSessionPath.slice(0, -".zst".length)
		: parentSessionPath;
	return withControlDb(controlDbPath, (db) =>
		(
			db
				.prepare(
					"SELECT session_path FROM session_metadata WHERE is_subagent = 1 AND parent_session_path IN (?, ?)",
				)
				.all(plainPath, `${plainPath}.zst`) as Array<{ session_path: string }>
		).map((row) => row.session_path),
	);
}

/** Lists unique transitive child agent paths, excluding both aliases of the root. */

export function listDescendantSessionPaths(controlDbPath: string, parentPath: string): string[] {
	const plainPath = parentPath.endsWith(".zst") ? parentPath.slice(0, -".zst".length) : parentPath;
	return withControlDb(controlDbPath, (db) =>
		(
			db
				.prepare(
					`WITH RECURSIVE descendants(session_path) AS (
						SELECT session_path FROM session_metadata
						WHERE is_subagent = 1 AND parent_session_path IN (?, ?)
						UNION
						SELECT child.session_path
						FROM descendants AS parent JOIN session_metadata AS child
						ON child.parent_session_path IN (
							CASE WHEN substr(parent.session_path, -4) = '.zst'
								THEN substr(parent.session_path, 1, length(parent.session_path) - 4)
								ELSE parent.session_path END,
							CASE WHEN substr(parent.session_path, -4) = '.zst'
								THEN parent.session_path ELSE parent.session_path || '.zst' END
						)
						WHERE child.is_subagent = 1
					)
					SELECT session_path FROM descendants WHERE session_path NOT IN (?, ?)`,
				)
				.all(plainPath, `${plainPath}.zst`, plainPath, `${plainPath}.zst`) as Array<{ session_path: string }>
		).map((row) => row.session_path),
	);
}

export function removeSessionMetadata(controlDbPath: string, sessionPath: string): void {
	removeSessionsMetadata(controlDbPath, [sessionPath]);
}

export function removeSessionsMetadata(controlDbPath: string, paths: readonly string[]): void {
	removeSessionPathRows(controlDbPath, paths, ["session_sandbox_profiles", "session_metadata"]);
}

/**
 * Removes all control data of deleted session transcripts, including their multi-agent records. Without a transcript
 * the session cannot resume, so its non-terminal agents would otherwise stay active forever.
 */

export function removeDeletedSessionsControlData(controlDbPath: string, paths: readonly string[]): void {
	removeSessionPathRows(controlDbPath, paths, [
		"session_sandbox_profiles",
		"session_metadata",
		"multi_agent_agents",
		"multi_agent_runtime_owners",
		"multi_agent_terminal_outbox",
		"multi_agent_mailbox_messages",
		"multi_agent_counters_v2",
	]);
}

export function removeSessionPathRows(
	controlDbPath: string,
	paths: readonly string[],
	tables: readonly string[],
): void {
	if (paths.length === 0) return;
	withControlDb(controlDbPath, (db) => {
		withImmediateTransaction(db, () => {
			const removals = tables.map((table) => db.prepare(`DELETE FROM ${table} WHERE session_path = ?`));
			for (const path of paths) {
				for (const removal of removals) removal.run(path);
			}
		});
	});
}

export function relocateSessionControlData(
	controlDbPath: string,
	oldSessionPath: string,
	newSessionPath: string,
): void {
	if (oldSessionPath === newSessionPath) return;
	withControlDb(controlDbPath, (db) => {
		withImmediateTransaction(db, () => {
			relocateSessionControlDataInTransaction(db, oldSessionPath, newSessionPath, new Date().toISOString());
		});
	});
}

export function relocateAndArchiveSession(controlDbPath: string, oldSessionPath: string, newSessionPath: string): void {
	withControlDb(controlDbPath, (db) => {
		withImmediateTransaction(db, () => {
			const now = new Date().toISOString();
			relocateSessionControlDataInTransaction(db, oldSessionPath, newSessionPath, now);
			db.prepare("UPDATE session_metadata SET archived_at = ?, updated_at = ? WHERE session_path = ?").run(
				now,
				now,
				newSessionPath,
			);
		});
	});
}

export function relocateAndUnarchiveSession(
	controlDbPath: string,
	oldSessionPath: string,
	newSessionPath: string,
): void {
	withControlDb(controlDbPath, (db) => {
		withImmediateTransaction(db, () => {
			const now = new Date().toISOString();
			relocateSessionControlDataInTransaction(db, oldSessionPath, newSessionPath, now);
			db.prepare("UPDATE session_metadata SET archived_at = NULL, updated_at = ? WHERE session_path = ?").run(
				now,
				newSessionPath,
			);
		});
	});
}

export function relocateSessionControlDataInTransaction(
	db: SqliteDatabase,
	oldSessionPath: string,
	newSessionPath: string,
	now: string,
): void {
	if (oldSessionPath === newSessionPath) return;
	relocateSessionPathPrimaryKey(db, "session_metadata", oldSessionPath, newSessionPath, now);
	relocateSessionPathPrimaryKey(db, "session_sandbox_profiles", oldSessionPath, newSessionPath, now);
	relocateMultiAgentSessionRows(db, "multi_agent_agents", oldSessionPath, newSessionPath, now);
	relocateMultiAgentRuntimeOwners(db, oldSessionPath, newSessionPath);
	relocateMultiAgentSessionRows(db, "multi_agent_terminal_outbox", oldSessionPath, newSessionPath, now);
	relocateMultiAgentSessionRows(db, "multi_agent_mailbox_messages", oldSessionPath, newSessionPath, now);
	relocateMultiAgentCounters(db, oldSessionPath, newSessionPath, now);
	relocateRuntimeMailboxListenerPaths(db, oldSessionPath, newSessionPath);
}

export function relocateRuntimeMailboxListenerPaths(
	db: SqliteDatabase,
	oldSessionPath: string,
	newSessionPath: string,
): void {
	db.prepare("UPDATE runtime_mailbox_listeners SET session_path = ? WHERE session_path = ?").run(
		newSessionPath,
		oldSessionPath,
	);
}

export function relocateSessionPathPrimaryKey(
	db: SqliteDatabase,
	table: string,
	oldSessionPath: string,
	newSessionPath: string,
	now: string,
): void {
	db.prepare(`DELETE FROM ${table} WHERE session_path = ?`).run(newSessionPath);
	db.prepare(`UPDATE ${table} SET session_path = ?, updated_at = ? WHERE session_path = ?`).run(
		newSessionPath,
		now,
		oldSessionPath,
	);
}

export type MultiAgentCounterRow = {
	next_agent_number: number;
	next_message_number: number;
};

export function relocateMultiAgentCounters(
	db: SqliteDatabase,
	oldSessionPath: string,
	newSessionPath: string,
	now: string,
): void {
	const readCounters = db.prepare(
		"SELECT next_agent_number, next_message_number FROM multi_agent_counters_v2 WHERE session_path = ?",
	);
	const oldCounters = readCounters.get(oldSessionPath) as MultiAgentCounterRow | undefined;
	if (!oldCounters) return;
	const newCounters = readCounters.get(newSessionPath) as MultiAgentCounterRow | undefined;
	db.prepare("DELETE FROM multi_agent_counters_v2 WHERE session_path = ?").run(newSessionPath);
	db.prepare(
		`UPDATE multi_agent_counters_v2
		 SET session_path = ?, next_agent_number = ?, next_message_number = ?, updated_at = ?
		 WHERE session_path = ?`,
	).run(
		newSessionPath,
		Math.max(oldCounters.next_agent_number, newCounters?.next_agent_number ?? 1),
		Math.max(oldCounters.next_message_number, newCounters?.next_message_number ?? 1),
		now,
		oldSessionPath,
	);
}

export function relocateMultiAgentRuntimeOwners(
	db: SqliteDatabase,
	oldSessionPath: string,
	newSessionPath: string,
): void {
	db.prepare("DELETE FROM multi_agent_runtime_owners WHERE session_path = ?").run(newSessionPath);
	db.prepare("UPDATE multi_agent_runtime_owners SET session_path = ? WHERE session_path = ?").run(
		newSessionPath,
		oldSessionPath,
	);
}

export function relocateMultiAgentSessionRows(
	db: SqliteDatabase,
	table: "multi_agent_agents" | "multi_agent_mailbox_messages" | "multi_agent_terminal_outbox",
	oldSessionPath: string,
	newSessionPath: string,
	now: string,
): void {
	relocateSessionPathPrimaryKey(db, table, oldSessionPath, newSessionPath, now);
}
