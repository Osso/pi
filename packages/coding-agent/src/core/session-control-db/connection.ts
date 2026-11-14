import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MAILBOX_MESSAGE_RETENTION_MS } from "../mailbox-retention.ts";
import { configureSharedSqliteDatabase, createSqliteDatabase, type SqliteDatabase } from "../sqlite.ts";
import { TERMINAL_AGENT_ROW_TABLES, withImmediateTransaction } from "./helpers.ts";
import {
	addMissingArchitectRequestColumns,
	addMissingIncomingMessageColumns,
	addMissingRuntimeMailboxListenerColumns,
	addMissingSessionMetadataColumns,
	addMissingSharedChannelOriginColumns,
	migrateLegacyMultiAgentCounters,
	migrateLegacyMultiAgentPayloads,
	migrateLegacySessionNames,
} from "./migrations.ts";
import { CONTROL_DB_SCHEMA_SQL } from "./schema.ts";
import {
	CONTROL_DB_SCHEMA_VERSION,
	LIFECYCLE_PROTOCOL_SCHEMA_VERSION,
	MAILBOX_CREATED_AT_MS_SQL,
	MAILBOX_RETENTION_POLL_MS,
} from "./types.ts";

export function prepareControlDbForSelfRestart(controlDbPath: string, processId: number): void {
	const db = createSqliteDatabase(controlDbPath);
	try {
		configureSharedSqliteDatabase(db);
		initializeSchema(db, processId);
	} finally {
		db.close();
	}
}

export type RetainedControlDb = {
	activeCalls: number;
	db: SqliteDatabase;
	retainCount: number;
	retentionTimer: ReturnType<typeof setInterval>;
};

export const retainedControlDbs = new Map<string, RetainedControlDb>();

export function retainControlDbConnection(controlDbPath: string): () => void {
	const retained = retainedControlDbs.get(controlDbPath) ?? openRetainedControlDb(controlDbPath);
	retained.retainCount += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		retained.retainCount -= 1;
		closeReleasedControlDb(controlDbPath, retained);
	};
}

export function createWritableControlDb(controlDbPath: string): SqliteDatabase {
	mkdirSync(dirname(controlDbPath), { mode: 0o700, recursive: true });
	return createSqliteDatabase(controlDbPath);
}

export function openRetainedControlDb(controlDbPath: string): RetainedControlDb {
	const db = createWritableControlDb(controlDbPath);
	try {
		configureSharedSqliteDatabase(db);
		initializeSchema(db);
		db.finalizeStatements?.();
	} catch (error) {
		db.close();
		throw error;
	}
	const retentionTimer = setInterval(() => {
		try {
			cleanupExpiredMessages(db);
		} catch (error) {
			console.error(`Message retention cleanup failed for ${controlDbPath}:`, error);
		} finally {
			db.finalizeStatements?.();
		}
	}, MAILBOX_RETENTION_POLL_MS);
	retentionTimer.unref();
	const retained = { activeCalls: 0, db, retainCount: 0, retentionTimer };
	retainedControlDbs.set(controlDbPath, retained);
	return retained;
}

export function closeReleasedControlDb(controlDbPath: string, retained: RetainedControlDb): void {
	if (retained.retainCount > 0 || retained.activeCalls > 0) return;
	clearInterval(retained.retentionTimer);
	retainedControlDbs.delete(controlDbPath);
	retained.db.close();
}

export function withControlDb<T>(controlDbPath: string, callback: (db: SqliteDatabase) => T): T {
	const retained = retainedControlDbs.get(controlDbPath);
	if (retained) {
		retained.activeCalls += 1;
		try {
			return callback(retained.db);
		} finally {
			retained.activeCalls -= 1;
			if (retained.activeCalls === 0) retained.db.finalizeStatements?.();
			closeReleasedControlDb(controlDbPath, retained);
		}
	}
	const db = createWritableControlDb(controlDbPath);
	try {
		// Shared control.sqlite is multi-process (all Pi sessions on the machine).
		// WAL + busy_timeout keeps list_sessions and mailbox writes safe under contention.
		configureSharedSqliteDatabase(db);
		initializeSchema(db);
		return callback(db);
	} finally {
		db.close();
	}
}

export function initializeSchema(db: SqliteDatabase, selfRestartProcessId?: number): void {
	assertSupportedControlDbSchemaVersion(db);
	db.exec(CONTROL_DB_SCHEMA_SQL);
	const schemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (schemaVersion.user_version >= LIFECYCLE_PROTOCOL_SCHEMA_VERSION) migrateLegacyMultiAgentCounters(db);
	migrateLegacyMultiAgentPayloads(db, selfRestartProcessId);
	addMissingSessionMetadataColumns(db);
	db.exec(`
		CREATE INDEX IF NOT EXISTS session_metadata_parent_session_path_idx
		ON session_metadata(parent_session_path);

		CREATE INDEX IF NOT EXISTS session_metadata_empty_main_idx
		ON session_metadata(id, session_path)
		WHERE archived_at IS NULL AND is_subagent = 0 AND message_count = 0;
	`);
	migrateLegacySessionNames(db, selfRestartProcessId);
	addMissingRuntimeMailboxListenerColumns(db);
	addMissingArchitectRequestColumns(db);
	addMissingSharedChannelOriginColumns(db);
	addMissingIncomingMessageColumns(db);
	// Already-running legacy producers insert directly. Only new undated rows receive birth.
	db.exec(`CREATE TRIGGER IF NOT EXISTS multi_agent_mailbox_default_birth
		AFTER INSERT ON multi_agent_mailbox_messages
		WHEN CASE WHEN json_valid(NEW.data) THEN
			COALESCE(json_type(NEW.data, '$.createdAt'), 'null') = 'null' ELSE 0 END
		BEGIN
			UPDATE multi_agent_mailbox_messages
			SET data = json_set(NEW.data, '$.createdAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
			WHERE rowid = NEW.rowid;
		END`);
	db.exec(`CREATE INDEX IF NOT EXISTS multi_agent_mailbox_created_at_ms_idx
		ON multi_agent_mailbox_messages(${MAILBOX_CREATED_AT_MS_SQL})`);
	cleanupExpiredMessages(db);
}

/** Mailbox messages, shared-channel messages, finished Supervisor requests and terminal agents share one 24h retention. */

export function cleanupExpiredMessages(db: SqliteDatabase): void {
	const cutoff = Date.now() - MAILBOX_MESSAGE_RETENTION_MS;
	const mailboxDue = db
		.prepare(`SELECT 1 FROM multi_agent_mailbox_messages
		WHERE ${MAILBOX_CREATED_AT_MS_SQL} <= ? LIMIT 1`)
		.get(cutoff);
	if (mailboxDue) {
		db.prepare(`DELETE FROM multi_agent_mailbox_messages
		WHERE ${MAILBOX_CREATED_AT_MS_SQL} <= ?`).run(cutoff);
	}
	const channelCutoff = new Date(cutoff).toISOString();
	const channelDue = db
		.prepare("SELECT 1 FROM shared_channel_messages WHERE created_at <= ? LIMIT 1")
		.get(channelCutoff);
	if (channelDue) db.prepare("DELETE FROM shared_channel_messages WHERE created_at <= ?").run(channelCutoff);
	const finishedSupervisorRequests =
		"FROM supervisor_requests WHERE status IN ('completed', 'cancelled') AND completed_at <= ?";
	if (db.prepare(`SELECT 1 ${finishedSupervisorRequests} LIMIT 1`).get(channelCutoff)) {
		db.prepare(`DELETE ${finishedSupervisorRequests}`).run(channelCutoff);
	}
	cleanupExpiredTerminalAgents(db, channelCutoff);
}

// Terminal agents expire 24h after their terminal update. Rows that own detached job output
// are deleted by artifact cleanup together with their directory, which it finds only through them.
// Undelivered terminal outbox rows and non-terminal children also keep a row alive.

export const EXPIRED_TERMINAL_AGENT_SQL = `WITH active_parent AS MATERIALIZED (
		SELECT DISTINCT session_path, json_extract(data, '$.parentId') AS agent_id FROM multi_agent_agents
		WHERE json_valid(data) AND json_extract(data, '$.parentId') IS NOT NULL
			AND json_extract(data, '$.lifecycle') NOT IN ('completed', 'failed', 'aborted')
	)
	SELECT agent.session_path, agent.agent_id FROM multi_agent_agents AS agent
	WHERE (CASE WHEN json_valid(agent.data) THEN json_extract(agent.data, '$.updatedAt') END) <= ?
		AND json_extract(agent.data, '$.lifecycle') IN ('completed', 'failed', 'aborted')
		AND NOT EXISTS (
			SELECT 1 FROM json_each(agent.data, '$.result.fileRefs') AS file_ref
			WHERE json_extract(file_ref.value, '$.label') IN ('Bash output', 'Pyrun output')
		)
		AND NOT EXISTS (
			SELECT 1 FROM multi_agent_terminal_outbox AS outbox
			WHERE outbox.session_path = agent.session_path AND outbox.agent_id = agent.agent_id
				AND outbox.delivered_at IS NULL
		)
		AND NOT EXISTS (
			SELECT 1 FROM active_parent
			WHERE active_parent.session_path = agent.session_path AND active_parent.agent_id = agent.agent_id
		)`;

export function cleanupExpiredTerminalAgents(db: SqliteDatabase, cutoff: string): void {
	const expired = db.prepare(EXPIRED_TERMINAL_AGENT_SQL).all(cutoff) as Array<{
		agent_id: string;
		session_path: string;
	}>;
	if (expired.length === 0) return;
	const deleteRows = TERMINAL_AGENT_ROW_TABLES.map((table) =>
		db.prepare(`DELETE FROM ${table} WHERE session_path = ? AND agent_id = ?`),
	);
	withImmediateTransaction(db, () => {
		for (const { agent_id, session_path } of expired) {
			for (const statement of deleteRows) statement.run(session_path, agent_id);
		}
	});
}

export function assertSupportedControlDbSchemaVersion(db: SqliteDatabase): void {
	const schemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (schemaVersion.user_version > CONTROL_DB_SCHEMA_VERSION) {
		throw new Error(
			`Unsupported control database schema version ${schemaVersion.user_version}; this Pi runtime supports up to version ${CONTROL_DB_SCHEMA_VERSION}`,
		);
	}
}
