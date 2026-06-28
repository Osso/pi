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

type IncomingRow = {
	id: number;
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

export function setNamedSession(controlDbPath: string, sessionPath: string, name: string): void {
	const trimmedName = name.trim();
	if (!trimmedName) {
		removeNamedSession(controlDbPath, sessionPath);
		return;
	}

	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`
			INSERT INTO named_sessions (session_path, name, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(session_path) DO UPDATE SET
				name = excluded.name,
				updated_at = excluded.updated_at
			`,
		).run(sessionPath, trimmedName, new Date().toISOString());
	});
}

export function removeNamedSession(controlDbPath: string, sessionPath: string): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare("DELETE FROM named_sessions WHERE session_path = ?").run(sessionPath);
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
	`);
}
