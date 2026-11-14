import { isPiRuntimeProcessAlive, isProcessIdentityAlive } from "../runtime-process.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import {
	addRuntimeMailboxRouting,
	arraysEqual,
	parseStoredJsonObject,
	requireStringField,
	stripLegacyArtifactFields,
	toRuntimeMailboxMessageKind,
	toRuntimeMailboxMessageStatus,
	validateMailboxPayload,
} from "./codecs.ts";
import {
	normalizeSessionName,
	type PersistedAgentRow,
	parseProcessIdentity,
	type TableInfoRow,
	withImmediateTransaction,
	writeCanonicalMailboxPayload,
} from "./helpers.ts";
import { CONTROL_DB_SCHEMA_VERSION, LIFECYCLE_PROTOCOL_SCHEMA_VERSION, type RuntimeMailboxRow } from "./types.ts";

export function migrateLegacyMultiAgentCounters(db: SqliteDatabase): void {
	const legacyTable = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'multi_agent_counters'")
		.get();
	if (legacyTable) {
		const legacyRows = db
			.prepare("SELECT session_path, next_agent_number, next_message_number, updated_at FROM multi_agent_counters")
			.all() as Array<{
			session_path: string;
			next_agent_number: number;
			next_message_number: number;
			updated_at: string;
		}>;
		const existing = db.prepare(
			"SELECT next_agent_number, next_message_number, updated_at FROM multi_agent_counters_v2 WHERE session_path = ?",
		);
		const upsert = db.prepare(
			`INSERT INTO multi_agent_counters_v2 (session_path, next_agent_number, next_message_number, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(session_path) DO UPDATE SET
			 next_agent_number = excluded.next_agent_number,
			 next_message_number = excluded.next_message_number,
			 updated_at = excluded.updated_at`,
		);
		for (const row of legacyRows) {
			const current = existing.get(row.session_path) as
				| { next_agent_number: number; next_message_number: number; updated_at: string }
				| undefined;
			upsert.run(
				row.session_path,
				Math.max(current?.next_agent_number ?? 1, row.next_agent_number),
				Math.max(current?.next_message_number ?? 1, row.next_message_number),
				current && current.updated_at > row.updated_at ? current.updated_at : row.updated_at,
			);
		}
		db.exec("DROP TABLE multi_agent_counters");
	}
	db.exec("DROP TABLE IF EXISTS multi_agent_artifacts");
}

export type LifecycleMigrationOwnerTableState = {
	kind: "missing" | "without_process_identity" | "with_process_identity";
	processIdentities: string[];
};

export type LifecycleProtocolMigrationState = {
	ownerTables: Record<"multi_agent_dispatch_leases" | "multi_agent_runtime_owners", LifecycleMigrationOwnerTableState>;
	runtimePids: number[];
};

export function migrateLegacyMultiAgentPayloads(db: SqliteDatabase, selfRestartProcessId?: number): void {
	const targetVersion = LIFECYCLE_PROTOCOL_SCHEMA_VERSION;
	const schemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (schemaVersion.user_version >= targetVersion) return;
	const migrationState = readLifecycleProtocolMigrationState(db);
	assertControlDbMigrationQuiescent(migrationState, selfRestartProcessId, "lifecycle protocol", targetVersion);
	const migrationTimestamp = new Date().toISOString();

	withImmediateTransaction(db, () => {
		const currentSchemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (currentSchemaVersion.user_version >= targetVersion) return;
		const currentMigrationState = readLifecycleProtocolMigrationState(db);
		if (!lifecycleProtocolMigrationStatesEqual(migrationState, currentMigrationState)) {
			throw new Error("Lifecycle protocol migration state changed while acquiring the writer lock; retry");
		}

		migrateLegacyMultiAgentCounters(db);
		dropLifecycleAccessControlTriggers(db);
		db.exec("DROP TABLE IF EXISTS multi_agent_recovery_leader");
		migrateTerminalOutboxSchema(db);
		migrateRuntimeOwnerTable(db);
		migrateLegacyLifecycleRows(db, migrationTimestamp);
		migrateLegacyMultiAgentPayloadTable(db, "multi_agent_agents", "agent_id", migrationTimestamp);
		migrateLegacyMultiAgentPayloadTable(db, "multi_agent_mailbox_messages", "message_id", migrationTimestamp);
		migrateLegacyRuntimeMailboxMessages(db, migrationTimestamp);
		createLegacyArtifactFieldTriggers(db);
		db.exec(`PRAGMA user_version = ${targetVersion}`);
	});
}

export function migrateLegacySessionNames(db: SqliteDatabase, selfRestartProcessId?: number): void {
	const targetVersion = CONTROL_DB_SCHEMA_VERSION;
	const schemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (schemaVersion.user_version >= targetVersion) return;
	const migrationState = readLifecycleProtocolMigrationState(db);
	assertControlDbMigrationQuiescent(migrationState, selfRestartProcessId, "session name schema", targetVersion);

	withImmediateTransaction(db, () => {
		const currentSchemaVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (currentSchemaVersion.user_version >= targetVersion) return;
		const currentMigrationState = readLifecycleProtocolMigrationState(db);
		if (!lifecycleProtocolMigrationStatesEqual(migrationState, currentMigrationState)) {
			throw new Error("Session name migration state changed while acquiring the writer lock; retry");
		}

		assertControlDbMigrationQuiescent(
			currentMigrationState,
			selfRestartProcessId,
			"session name schema",
			targetVersion,
		);
		moveLegacySessionNamesIntoMetadata(db);
		db.exec(`PRAGMA user_version = ${targetVersion}`);
	});
}

export function moveLegacySessionNamesIntoMetadata(db: SqliteDatabase): void {
	const legacyTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'named_sessions'").get();
	if (!legacyTable) return;

	const legacyRows = db.prepare("SELECT session_path, name FROM named_sessions").all() as Array<{
		session_path: string;
		name: string;
	}>;
	const writeName = db.prepare("UPDATE session_metadata SET name = ? WHERE session_path = ?");
	for (const row of legacyRows) {
		writeName.run(normalizeSessionName(row.name) ?? "", row.session_path);
	}
	db.exec("DROP TABLE named_sessions");
}

export function readLifecycleProtocolMigrationState(db: SqliteDatabase): LifecycleProtocolMigrationState {
	const runtimePids = (
		db
			.prepare(
				`SELECT pid FROM runtime_mailbox_listeners
				 UNION
				 SELECT pid FROM session_health WHERE pid IS NOT NULL
				 ORDER BY pid`,
			)
			.all() as Array<{ pid: number }>
	).map((row) => row.pid);
	return {
		ownerTables: {
			multi_agent_dispatch_leases: readLifecycleMigrationOwnerTableState(db, "multi_agent_dispatch_leases"),
			multi_agent_runtime_owners: readLifecycleMigrationOwnerTableState(db, "multi_agent_runtime_owners"),
		},
		runtimePids,
	};
}

export function readLifecycleMigrationOwnerTableState(
	db: SqliteDatabase,
	tableName: "multi_agent_dispatch_leases" | "multi_agent_runtime_owners",
): LifecycleMigrationOwnerTableState {
	const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
	if (!tableExists) return { kind: "missing", processIdentities: [] };
	const ownerColumns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
	if (!ownerColumns.some((column) => column.name === "process_identity")) {
		return { kind: "without_process_identity", processIdentities: [] };
	}
	const processIdentities = (
		db
			.prepare(
				`SELECT process_identity FROM ${tableName} WHERE process_identity IS NOT NULL ORDER BY process_identity`,
			)
			.all() as Array<{ process_identity: string }>
	).map((owner) => owner.process_identity);
	return { kind: "with_process_identity", processIdentities };
}

export function assertControlDbMigrationQuiescent(
	state: LifecycleProtocolMigrationState,
	selfRestartProcessId: number | undefined,
	migrationName: string,
	targetVersion: number,
): void {
	const liveRuntimePids = state.runtimePids.filter(isPiRuntimeProcessAlive);
	for (const tableState of Object.values(state.ownerTables)) {
		for (const serializedIdentity of tableState.processIdentities) {
			try {
				const identity = parseProcessIdentity(serializedIdentity);
				if (isProcessIdentityAlive(identity)) liveRuntimePids.push(identity.pid);
			} catch {
				// Pre-v11 runtime identities did not contain OS process identity.
			}
		}
	}
	const uniqueLivePids = [...new Set(liveRuntimePids)].filter((pid) => pid !== selfRestartProcessId);
	if (uniqueLivePids.length === 0) return;
	throw new Error(
		`Cannot activate ${migrationName} version ${targetVersion} while lifecycle owners are active (PIDs: ${uniqueLivePids.join(", ")}). Stop all Pi and detached runner processes, then retry`,
	);
}

export function lifecycleProtocolMigrationStatesEqual(
	expected: LifecycleProtocolMigrationState,
	current: LifecycleProtocolMigrationState,
): boolean {
	return (
		lifecycleMigrationOwnerTableStatesEqual(
			expected.ownerTables.multi_agent_dispatch_leases,
			current.ownerTables.multi_agent_dispatch_leases,
		) &&
		lifecycleMigrationOwnerTableStatesEqual(
			expected.ownerTables.multi_agent_runtime_owners,
			current.ownerTables.multi_agent_runtime_owners,
		) &&
		arraysEqual(expected.runtimePids, current.runtimePids)
	);
}

export function lifecycleMigrationOwnerTableStatesEqual(
	expected: LifecycleMigrationOwnerTableState,
	current: LifecycleMigrationOwnerTableState,
): boolean {
	return expected.kind === current.kind && arraysEqual(expected.processIdentities, current.processIdentities);
}

export function migrateTerminalOutboxSchema(db: SqliteDatabase): void {
	const eventTableExists = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'multi_agent_terminal_events'")
		.get();
	if (!eventTableExists) return;
	db.exec(`
		DROP TABLE IF EXISTS multi_agent_terminal_cursors;
		ALTER TABLE multi_agent_terminal_outbox RENAME TO multi_agent_terminal_outbox_v12;
		CREATE TABLE multi_agent_terminal_outbox (
			session_path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			terminal_revision INTEGER NOT NULL,
			event_kind TEXT NOT NULL,
			status TEXT NOT NULL,
			claim_id TEXT,
			claimed_at TEXT,
			delivered_at TEXT,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (session_path, agent_id, terminal_revision, event_kind)
		);
		INSERT INTO multi_agent_terminal_outbox
		SELECT * FROM multi_agent_terminal_outbox_v12 WHERE status != 'delivered';
		DROP TABLE multi_agent_terminal_outbox_v12;
		DROP TABLE multi_agent_terminal_events;
		CREATE INDEX IF NOT EXISTS multi_agent_terminal_outbox_status_idx
		ON multi_agent_terminal_outbox(status, updated_at);
	`);
}

export function migrateRuntimeOwnerTable(db: SqliteDatabase): void {
	const oldTableExists = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'multi_agent_dispatch_leases'")
		.get();
	if (oldTableExists) {
		const oldColumns = db.prepare("PRAGMA table_info(multi_agent_dispatch_leases)").all() as Array<{ name: string }>;
		const hasExactProcessIdentity = oldColumns.some((column) => column.name === "process_identity");
		const copyColumns = hasExactProcessIdentity
			? `session_path, agent_id, process_identity, owner_session_id, owner_agent_id`
			: `session_path, agent_id`;
		db.exec(`
			INSERT OR REPLACE INTO multi_agent_runtime_owners (${copyColumns})
			SELECT ${copyColumns} FROM multi_agent_dispatch_leases;
			DROP TABLE multi_agent_dispatch_leases;
			DROP INDEX IF EXISTS multi_agent_dispatch_leases_expiry_idx;
		`);
	}

	const columns = db.prepare("PRAGMA table_info(multi_agent_runtime_owners)").all() as Array<{ name: string }>;
	if (!columns.some((column) => column.name === "lease_id")) return;
	db.exec(`
		ALTER TABLE multi_agent_runtime_owners RENAME TO multi_agent_runtime_owners_legacy;
		CREATE TABLE multi_agent_runtime_owners (
			session_path TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			process_identity TEXT,
			owner_session_id TEXT,
			owner_agent_id TEXT,
			PRIMARY KEY (session_path, agent_id)
		);
		INSERT INTO multi_agent_runtime_owners (session_path, agent_id)
		SELECT session_path, agent_id FROM multi_agent_runtime_owners_legacy;
		DROP TABLE multi_agent_runtime_owners_legacy;
		DROP INDEX IF EXISTS multi_agent_runtime_owners_expiry_idx;
	`);
}

export function migrateLegacyLifecycleRows(db: SqliteDatabase, nowIso: string): void {
	const rows = db
		.prepare(`SELECT agents.session_path, agents.agent_id, agents.data
		FROM multi_agent_agents AS agents LEFT JOIN multi_agent_runtime_owners AS owners
		ON owners.session_path = agents.session_path AND owners.agent_id = agents.agent_id
		WHERE owners.agent_id IS NULL OR owners.process_identity IS NULL`)
		.all() as PersistedAgentRow[];
	for (const row of rows) {
		const agent = parseStoredJsonObject(row.data, `multi_agent_agents:${row.session_path}#${row.agent_id}`);
		if (agent.lifecycle === "queued") {
			db.prepare(`INSERT OR IGNORE INTO multi_agent_runtime_owners (session_path, agent_id) VALUES (?, ?)`).run(
				row.session_path,
				row.agent_id,
			);
			continue;
		}
		if (
			typeof agent.lifecycle !== "string" ||
			!["starting", "running", "waiting_for_input", "steering_pending", "cancelling"].includes(agent.lifecycle)
		)
			continue;
		const terminalRevision = typeof agent.revision === "number" ? agent.revision + 1 : 1;
		const error = {
			code: "lost_runtime",
			message: "Legacy active agent had no fenced runtime ownership during protocol migration.",
		};
		const updated = {
			...agent,
			error,
			lifecycle: "failed",
			revision: terminalRevision,
			updatedAt: nowIso,
			worker: undefined,
		};
		db.prepare("UPDATE multi_agent_agents SET data = ?, updated_at = ? WHERE session_path = ? AND agent_id = ?").run(
			JSON.stringify(updated),
			nowIso,
			row.session_path,
			row.agent_id,
		);
		db.prepare(
			`INSERT INTO multi_agent_terminal_outbox (session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at) VALUES (?, ?, ?, 'lost_runtime', 'pending', 0, ?)`,
		).run(row.session_path, row.agent_id, terminalRevision, nowIso);
	}
}

export function dropLifecycleAccessControlTriggers(db: SqliteDatabase): void {
	db.exec(`
		DROP TRIGGER IF EXISTS multi_agent_agents_require_authorized_lifecycle_update;
		DROP TRIGGER IF EXISTS multi_agent_agents_require_lifecycle_protocol_insert;
		DROP TRIGGER IF EXISTS multi_agent_agents_require_lifecycle_protocol_update;
	`);
}

export function migrateLegacyMultiAgentPayloadTable(
	db: SqliteDatabase,
	table: "multi_agent_agents" | "multi_agent_mailbox_messages",
	idColumn: "agent_id" | "message_id",
	now: string,
): void {
	const rows = db.prepare(`SELECT session_path, ${idColumn}, data FROM ${table}`).all() as Array<{
		session_path: string;
		data: string;
		[key: string]: string;
	}>;
	const update = db.prepare(`UPDATE ${table} SET data = ?, updated_at = ? WHERE session_path = ? AND ${idColumn} = ?`);
	for (const row of rows) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.data) as unknown;
		} catch {
			// Leave malformed payloads for the normal restore validator to report with row context.
			continue;
		}
		const migrated = stripLegacyArtifactFields(parsed);
		if (!migrated.changed) continue;
		const id = row[idColumn];
		if (id === undefined) throw new Error(`session row is missing ${idColumn}`);
		update.run(JSON.stringify(migrated.value), now, row.session_path, id);
	}
}

export function createLegacyArtifactFieldTriggers(db: SqliteDatabase): void {
	for (const table of ["multi_agent_agents", "multi_agent_mailbox_messages"] as const) {
		db.exec(`
			CREATE TRIGGER IF NOT EXISTS ${table}_reject_legacy_artifact_fields_insert
			BEFORE INSERT ON ${table}
			FOR EACH ROW
			WHEN json_valid(NEW.data)
				AND EXISTS (
					SELECT 1 FROM json_tree(NEW.data)
					WHERE key IN ('artifactIds', 'artifactRefs')
				)
			BEGIN
				SELECT RAISE(ABORT, 'Legacy artifact fields are not supported');
			END;

			CREATE TRIGGER IF NOT EXISTS ${table}_reject_legacy_artifact_fields_update
			BEFORE UPDATE OF data ON ${table}
			FOR EACH ROW
			WHEN json_valid(NEW.data)
				AND EXISTS (
					SELECT 1 FROM json_tree(NEW.data)
					WHERE key IN ('artifactIds', 'artifactRefs')
				)
			BEGIN
				SELECT RAISE(ABORT, 'Legacy artifact fields are not supported');
			END;
		`);
	}
}

export type LegacyRuntimeMailboxRow = {
	recipient_session_id: string;
	recipient_agent_id: string | null;
	sender_session_id: string | null;
	sender_agent_id: string | null;
	kind: string;
	store_session_path: string;
	store_message_id: string;
	status: string;
	created_at: string;
	updated_at: string;
	error: string | null;
};

export function migrateLegacyRuntimeMailboxMessages(db: SqliteDatabase, nowIso: string): void {
	const tableExists = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_mailbox_messages'")
		.get();
	if (!tableExists) return;
	const columns = new Set(
		(db.prepare("PRAGMA table_info(runtime_mailbox_messages)").all() as TableInfoRow[]).map((column) => column.name),
	);
	if (!columns.has("store_session_path") || !columns.has("store_message_id")) {
		db.exec("DROP TABLE runtime_mailbox_messages");
		return;
	}
	const rows = db
		.prepare(
			`SELECT recipient_session_id, recipient_agent_id, sender_session_id, sender_agent_id,
			        kind, store_session_path, store_message_id, status, created_at, updated_at, error
			 FROM runtime_mailbox_messages
			 WHERE store_session_path IS NOT NULL AND store_message_id IS NOT NULL
			 ORDER BY CASE status WHEN 'delivered' THEN 4 WHEN 'failed' THEN 3 WHEN 'claimed' THEN 2 ELSE 1 END DESC,
			          updated_at DESC, id DESC`,
		)
		.all() as LegacyRuntimeMailboxRow[];
	const migrated = new Set<string>();
	for (const row of rows) {
		const key = `${row.store_session_path}\u0000${row.store_message_id}`;
		if (migrated.has(key)) continue;
		migrated.add(key);
		migrateLegacyRuntimeMailboxRow(db, row, nowIso);
	}
	db.exec(`
		DROP INDEX IF EXISTS runtime_mailbox_store_ref_unique_idx;
		DROP INDEX IF EXISTS runtime_mailbox_recipient_status_idx;
		DROP INDEX IF EXISTS runtime_mailbox_created_at_idx;
		DROP TABLE runtime_mailbox_messages;
	`);
}

export function migrateLegacyRuntimeMailboxRow(db: SqliteDatabase, row: LegacyRuntimeMailboxRow, nowIso: string): void {
	const storeRef = { messageId: row.store_message_id, sessionPath: row.store_session_path };
	// Migration must validate legacy payloads before initialization applies retention.
	const canonical = db
		.prepare(`SELECT rowid AS id, session_path, message_id, data, updated_at
		FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?`)
		.get(storeRef.sessionPath, storeRef.messageId) as RuntimeMailboxRow | undefined;
	if (!canonical) return;
	const context = `multi_agent_mailbox_messages:${row.store_session_path}#${row.store_message_id}`;
	const message = parseStoredJsonObject(canonical.data, context);
	validateMailboxPayload(message, context);
	const routed = addRuntimeMailboxRouting(message, {
		kind: toRuntimeMailboxMessageKind(row.kind),
		recipient: { agentId: row.recipient_agent_id, sessionId: row.recipient_session_id },
		sender: { agentId: row.sender_agent_id, sessionId: row.sender_session_id ?? "" },
		storeRef,
	});
	if (routed.status === "delivered" || row.status === "delivered") {
		db.prepare("DELETE FROM multi_agent_mailbox_messages WHERE session_path = ? AND message_id = ?").run(
			storeRef.sessionPath,
			storeRef.messageId,
		);
		return;
	}
	const canonicalStatus = toRuntimeMailboxMessageStatus(requireStringField(routed, "status", context));
	const legacyStatus = row.status === "claimed" ? "pending" : toRuntimeMailboxMessageStatus(row.status);
	const status = canonicalStatus === "failed" ? canonicalStatus : legacyStatus;
	const updated: Record<string, unknown> = {
		...routed,
		createdAt: typeof routed.createdAt === "string" ? routed.createdAt : row.created_at,
		status,
		updatedAt: row.updated_at || nowIso,
	};
	delete updated.claimedAt;
	delete updated.claimantProcessIdentity;
	if (status === "failed") {
		updated.error = typeof routed.error === "string" ? routed.error : row.error;
	}
	writeCanonicalMailboxPayload(db, canonical.id, updated, row.updated_at || nowIso);
}

/**
 * Processes that open a database at the same time all see a column missing. Checking again inside an immediate
 * transaction makes the check and the ALTER atomic, so only the first process changes the table.
 */
function alterTableColumns(db: SqliteDatabase, table: string, add: Record<string, string>, drop: string[] = []): void {
	const pendingStatements = () => {
		const columns = new Set(
			(db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]).map((column) => column.name),
		);
		return [
			...Object.entries(add)
				.filter(([column]) => !columns.has(column))
				.map(([column, definition]) => `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`),
			...drop.filter((column) => columns.has(column)).map((column) => `ALTER TABLE ${table} DROP COLUMN ${column}`),
		];
	};
	if (pendingStatements().length === 0) return;
	withImmediateTransaction(db, () => {
		for (const statement of pendingStatements()) db.exec(statement);
	});
}

export function addMissingSharedChannelOriginColumns(db: SqliteDatabase): void {
	alterTableColumns(db, "shared_channel_messages", { origin_host: "TEXT", origin_id: "INTEGER" });
	db.exec(
		"CREATE UNIQUE INDEX IF NOT EXISTS shared_channel_origin_idx ON shared_channel_messages(origin_host, origin_id) WHERE origin_host IS NOT NULL",
	);
}

export function addMissingIncomingMessageColumns(db: SqliteDatabase): void {
	alterTableColumns(db, "incoming_messages", { target_session_id: "TEXT" });
}

export function addMissingSupervisorRequestColumns(db: SqliteDatabase): void {
	alterTableColumns(db, "supervisor_requests", { reply_to_json: "TEXT" });
}

export function addMissingArchitectRequestColumns(db: SqliteDatabase): void {
	alterTableColumns(db, "architect_requests", { project_cwd: "TEXT", claimed_at: "TEXT", claim_token: "TEXT" });
}

export function addMissingRuntimeMailboxListenerColumns(db: SqliteDatabase): void {
	alterTableColumns(db, "runtime_mailbox_listeners", {
		runtime_instance_id: "TEXT",
		session_path: "TEXT",
		session_path_asserted_at: "TEXT",
	});
}

export function addMissingSessionMetadataColumns(db: SqliteDatabase): void {
	alterTableColumns(
		db,
		"session_metadata",
		{
			name: "TEXT",
			parent_session_path: "TEXT",
			archived_at: "TEXT",
			goal_json: "TEXT",
			is_subagent: "INTEGER NOT NULL DEFAULT 0",
			subagent_name: "TEXT",
			model_provider: "TEXT",
			model_id: "TEXT",
			thinking_level: "TEXT",
		},
		["all_messages_text"],
	);
}
