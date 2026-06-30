import { join } from "node:path";
import { createSqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

export interface IncomingControlMessage {
	id: number;
	content: string;
}

export interface LastControlMessage {
	role: "assistant";
	content: string;
	updatedAt: string;
}

export interface NamedSession {
	sessionPath: string;
	name: string;
	updatedAt: string;
}

export interface SessionMetadata {
	sessionPath: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	goalJson?: string;
	isSubagent?: boolean;
	subagentName?: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	updatedAt: string;
}

export type WritableSessionMetadata = Omit<SessionMetadata, "updatedAt">;

type IncomingRow = {
	id: number;
	content: string;
};

type PromptHistoryRow = {
	content: string;
};

type LastMessageRow = {
	role: string;
	content: string;
	updated_at: string;
};

type IncomingStatusRow = {
	status: string;
};

type NamedSessionRow = {
	session_path: string;
	name: string;
	updated_at: string;
};

type SessionMetadataRow = {
	session_path: string;
	id: string;
	cwd: string;
	name: string | null;
	parent_session_path: string | null;
	goal_json: string | null;
	is_subagent: number;
	subagent_name: string | null;
	created_at: string;
	modified_at: string;
	message_count: number;
	first_message: string;
	all_messages_text: string;
	updated_at: string;
};

type SessionMetadataPreservedRow = {
	goal_json: string | null;
	is_subagent: number;
	subagent_name: string | null;
};

type TableInfoRow = {
	name: string;
};

type GoalRow = {
	goal_json: string | null;
};

export function getControlDbPath(agentDir: string): string {
	return join(agentDir, "control.sqlite");
}

export function enqueueIncomingMessage(controlDbPath: string, content: string): number {
	return withControlDb(controlDbPath, (db) => {
		const result = db
			.prepare(
				`
				INSERT INTO incoming_messages (content, status, created_at)
				VALUES (?, 'pending', ?)
				`,
			)
			.run(content, new Date().toISOString());
		return Number(result.lastInsertRowid);
	});
}

export function claimLatestIncomingMessage(controlDbPath: string): IncomingControlMessage | undefined {
	return withControlDb(controlDbPath, (db) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const row = db
				.prepare(
					`
					SELECT id, content
					FROM incoming_messages
					WHERE status = 'pending'
					ORDER BY id DESC
					LIMIT 1
					`,
				)
				.get() as IncomingRow | undefined;

			if (!row) {
				db.exec("COMMIT");
				return undefined;
			}

			const now = new Date().toISOString();
			db.prepare(
				`
				UPDATE incoming_messages
				SET status = 'superseded', completed_at = ?
				WHERE status = 'pending' AND id <> ?
				`,
			).run(now, row.id);
			db.prepare(
				`
				UPDATE incoming_messages
				SET status = 'claimed', claimed_at = ?
				WHERE id = ?
				`,
			).run(now, row.id);
			db.exec("COMMIT");
			return row;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

export function completeIncomingMessage(controlDbPath: string, id: number): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			UPDATE incoming_messages
			SET status = 'completed', completed_at = ?
			WHERE id = ?
			`,
		).run(new Date().toISOString(), id);
	});
}

export function failIncomingMessage(controlDbPath: string, id: number, errorMessage: string): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			UPDATE incoming_messages
			SET status = 'failed', error = ?, completed_at = ?
			WHERE id = ?
			`,
		).run(errorMessage, new Date().toISOString(), id);
	});
}

export function readIncomingMessageStatus(controlDbPath: string, id: number): string | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`
				SELECT status
				FROM incoming_messages
				WHERE id = ?
				`,
			)
			.get(id) as IncomingStatusRow | undefined;
		return row?.status;
	});
}

export function writeLastMessage(controlDbPath: string, message: { role: "assistant"; content: string }): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			INSERT INTO last_message (id, role, content, updated_at)
			VALUES (1, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				role = excluded.role,
				content = excluded.content,
				updated_at = excluded.updated_at
			`,
		).run(message.role, message.content, new Date().toISOString());
	});
}

export function readLastMessage(controlDbPath: string): LastControlMessage | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`
				SELECT role, content, updated_at
				FROM last_message
				WHERE id = 1
				`,
			)
			.get() as LastMessageRow | undefined;

		if (!row) return undefined;
		if (row.role !== "assistant") return undefined;
		return {
			role: row.role,
			content: row.content,
			updatedAt: row.updated_at,
		};
	});
}

export function recordPromptHistoryEntry(controlDbPath: string, content: string): void {
	withControlDb(controlDbPath, (db) => {
		insertPromptHistoryEntry(db, content);
	});
}

export function readPromptHistory(controlDbPath: string, limit = 100): string[] {
	return withControlDb(controlDbPath, (db) => readPromptHistoryRows(db, limit));
}

export function readOrMigratePromptHistory(controlDbPath: string, legacyEntries: string[], limit = 100): string[] {
	return withControlDb(controlDbPath, (db) => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const existingEntries = readPromptHistoryRows(db, limit);
			if (existingEntries.length > 0) {
				db.exec("COMMIT");
				return existingEntries;
			}

			for (const entry of [...legacyEntries].reverse()) {
				insertPromptHistoryEntry(db, entry);
			}
			db.exec("COMMIT");
			return legacyEntries.slice(0, limit);
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

function readPromptHistoryRows(db: SqliteDatabase, limit: number): string[] {
	const rows = db
		.prepare(
			`
			SELECT content
			FROM prompt_history
			ORDER BY id DESC
			LIMIT ?
			`,
		)
		.all(limit) as PromptHistoryRow[];
	return rows.map((row) => row.content);
}

function insertPromptHistoryEntry(db: SqliteDatabase, content: string): void {
	db.prepare(
		`
		INSERT INTO prompt_history (content, created_at)
		VALUES (?, ?)
		`,
	).run(content, new Date().toISOString());
}

export function setNamedSession(controlDbPath: string, sessionPath: string, name: string): void {
	const trimmedName = name.trim();
	if (!trimmedName) {
		removeNamedSession(controlDbPath, sessionPath);
		return;
	}

	withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		db.prepare(
			`
			INSERT INTO named_sessions (session_path, name, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(session_path) DO UPDATE SET
				name = excluded.name,
				updated_at = excluded.updated_at
			`,
		).run(sessionPath, trimmedName, now);
		db.prepare(
			`
			UPDATE session_metadata
			SET name = ?, updated_at = ?
			WHERE session_path = ?
			`,
		).run(trimmedName, now, sessionPath);
	});
}

export function removeNamedSession(controlDbPath: string, sessionPath: string): void {
	withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		db.prepare("DELETE FROM named_sessions WHERE session_path = ?").run(sessionPath);
		db.prepare(
			`
			UPDATE session_metadata
			SET name = NULL, updated_at = ?
			WHERE session_path = ?
			`,
		).run(now, sessionPath);
	});
}

export function listNamedSessions(controlDbPath: string): NamedSession[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`
				SELECT session_path, name, updated_at
				FROM named_sessions
				ORDER BY updated_at DESC
				`,
			)
			.all() as NamedSessionRow[];
		return rows.map((row) => ({
			sessionPath: row.session_path,
			name: row.name,
			updatedAt: row.updated_at,
		}));
	});
}

export function writeSessionMetadata(controlDbPath: string, metadata: WritableSessionMetadata): void {
	withControlDb(controlDbPath, (db) => {
		const metadataName = metadata.name ?? readNamedSessionName(db, metadata.sessionPath);
		const preserved = readPreservedSessionMetadata(db, metadata.sessionPath);
		const goalJson = metadata.goalJson ?? preserved?.goal_json ?? null;
		const preservedIsSubagent = preserved?.is_subagent === 1;
		const isSubagent = metadata.isSubagent ?? preservedIsSubagent;
		const subagentName = metadata.subagentName ?? preserved?.subagent_name ?? null;
		db.prepare(
			`
			INSERT INTO session_metadata (
				session_path,
				id,
				cwd,
				name,
				parent_session_path,
				goal_json,
				is_subagent,
				subagent_name,
				created_at,
				modified_at,
				message_count,
				first_message,
				all_messages_text,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_path) DO UPDATE SET
				id = excluded.id,
				cwd = excluded.cwd,
				name = excluded.name,
				parent_session_path = excluded.parent_session_path,
				goal_json = excluded.goal_json,
				is_subagent = excluded.is_subagent,
				subagent_name = excluded.subagent_name,
				created_at = excluded.created_at,
				modified_at = excluded.modified_at,
				message_count = excluded.message_count,
				first_message = excluded.first_message,
				all_messages_text = excluded.all_messages_text,
				updated_at = excluded.updated_at
			`,
		).run(
			metadata.sessionPath,
			metadata.id,
			metadata.cwd,
			metadataName,
			metadata.parentSessionPath ?? null,
			goalJson,
			isSubagent ? 1 : 0,
			subagentName,
			metadata.createdAt,
			metadata.modifiedAt,
			metadata.messageCount,
			metadata.firstMessage,
			metadata.allMessagesText,
			new Date().toISOString(),
		);
	});
}

function readPreservedSessionMetadata(
	db: SqliteDatabase,
	sessionPath: string,
): SessionMetadataPreservedRow | undefined {
	return db
		.prepare(
			`
			SELECT goal_json, is_subagent, subagent_name
			FROM session_metadata
			WHERE session_path = ?
			`,
		)
		.get(sessionPath) as SessionMetadataPreservedRow | undefined;
}

export function writeSessionGoal(controlDbPath: string, sessionPath: string, goalJson: string | undefined): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			UPDATE session_metadata
			SET goal_json = ?, updated_at = ?
			WHERE session_path = ?
			`,
		).run(goalJson ?? null, new Date().toISOString(), sessionPath);
	});
}

export function readSessionGoal(controlDbPath: string, sessionPath: string): string | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`
				SELECT goal_json
				FROM session_metadata
				WHERE session_path = ?
				`,
			)
			.get(sessionPath) as GoalRow | undefined;
		return row?.goal_json ?? undefined;
	});
}

function readNamedSessionName(db: SqliteDatabase, sessionPath: string): string | null {
	const row = db.prepare("SELECT name FROM named_sessions WHERE session_path = ?").get(sessionPath) as
		| { name: string }
		| undefined;
	return row?.name ?? null;
}

export function readSessionMetadata(controlDbPath: string, sessionPath: string): SessionMetadata | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`
				SELECT
					session_path,
					id,
					cwd,
					name,
					parent_session_path,
					goal_json,
					is_subagent,
					subagent_name,
					created_at,
					modified_at,
					message_count,
					first_message,
					all_messages_text,
					updated_at
				FROM session_metadata
				WHERE session_path = ?
				`,
			)
			.get(sessionPath) as SessionMetadataRow | undefined;
		return row ? sessionMetadataFromRow(row) : undefined;
	});
}

export function listSessionMetadata(controlDbPath: string): SessionMetadata[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`
				SELECT
					session_path,
					id,
					cwd,
					name,
					parent_session_path,
					goal_json,
					is_subagent,
					subagent_name,
					created_at,
					modified_at,
					message_count,
					first_message,
					all_messages_text,
					updated_at
				FROM session_metadata
				ORDER BY modified_at DESC, updated_at DESC
				`,
			)
			.all() as SessionMetadataRow[];
		return rows.map(sessionMetadataFromRow);
	});
}

function sessionMetadataFromRow(row: SessionMetadataRow): SessionMetadata {
	return {
		sessionPath: row.session_path,
		id: row.id,
		cwd: row.cwd,
		name: row.name ?? undefined,
		parentSessionPath: row.parent_session_path ?? undefined,
		goalJson: row.goal_json ?? undefined,
		isSubagent: row.is_subagent === 1,
		subagentName: row.subagent_name ?? undefined,
		createdAt: row.created_at,
		modifiedAt: row.modified_at,
		messageCount: row.message_count,
		firstMessage: row.first_message,
		allMessagesText: row.all_messages_text,
		updatedAt: row.updated_at,
	};
}

function withControlDb<T>(controlDbPath: string, callback: (db: SqliteDatabase) => T): T {
	const db = createSqliteDatabase(controlDbPath);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		initializeSchema(db);
		return callback(db);
	} finally {
		db.close();
	}
}

function initializeSchema(db: SqliteDatabase): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS incoming_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			content TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			claimed_at TEXT,
			completed_at TEXT,
			error TEXT
		);

		CREATE TABLE IF NOT EXISTS last_message (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS named_sessions (
			session_path TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS prompt_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS prompt_history_id_idx
		ON prompt_history(id DESC);

		CREATE TABLE IF NOT EXISTS session_metadata (
			session_path TEXT PRIMARY KEY,
			id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			name TEXT,
			parent_session_path TEXT,
			goal_json TEXT,
			is_subagent INTEGER NOT NULL DEFAULT 0,
			subagent_name TEXT,
			created_at TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			message_count INTEGER NOT NULL,
			first_message TEXT NOT NULL,
			all_messages_text TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS session_metadata_modified_at_idx
		ON session_metadata(modified_at DESC, updated_at DESC);
	`);
	addMissingSessionMetadataColumns(db);
}

function addMissingSessionMetadataColumns(db: SqliteDatabase): void {
	const columns = new Set(
		(db.prepare("PRAGMA table_info(session_metadata)").all() as TableInfoRow[]).map((column) => column.name),
	);
	if (!columns.has("goal_json")) {
		db.exec("ALTER TABLE session_metadata ADD COLUMN goal_json TEXT");
	}
	if (!columns.has("is_subagent")) {
		db.exec("ALTER TABLE session_metadata ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0");
	}
	if (!columns.has("subagent_name")) {
		db.exec("ALTER TABLE session_metadata ADD COLUMN subagent_name TEXT");
	}
}
