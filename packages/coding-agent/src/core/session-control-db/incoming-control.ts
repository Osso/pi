import type { SqliteDatabase } from "../sqlite.ts";
import { withControlDb } from "./connection.ts";
import { withImmediateTransaction } from "./helpers.ts";
import type { IncomingControlMessage, IncomingRow } from "./types.ts";

export type IncomingStatusRow = {
	status: string;
};

export function enqueueIncomingMessage(controlDbPath: string, content: string, targetSessionId?: string): number {
	return withControlDb(controlDbPath, (db) => {
		const result = db
			.prepare(
				`
				INSERT INTO incoming_messages (content, status, created_at, target_session_id)
				VALUES (?, 'pending', ?, ?)
				`,
			)
			.run(content, new Date().toISOString(), targetSessionId ?? null);
		return Number(result.lastInsertRowid);
	});
}

/** The session a running Pi process serves, from its newest healthy session-health row. */

export function claimLatestIncomingMessage(
	controlDbPath: string,
	sessionId: string,
): IncomingControlMessage | undefined {
	return withControlDb(controlDbPath, (db) => {
		if (!readLatestPendingIncomingMessage(db, sessionId)) return undefined;
		const nowIso = new Date().toISOString();
		return withImmediateTransaction(db, () => claimLatestIncomingMessageInTransaction(db, sessionId, nowIso));
	});
}

export function claimLatestIncomingMessageInTransaction(
	db: SqliteDatabase,
	sessionId: string,
	now: string,
): IncomingControlMessage | undefined {
	const row = readLatestPendingIncomingMessage(db, sessionId);
	if (!row) return undefined;
	db.prepare(
		`
		UPDATE incoming_messages
		SET status = 'superseded', completed_at = ?
		WHERE status = 'pending' AND id <> ? AND (target_session_id = ? OR target_session_id IS NULL)
		`,
	).run(now, row.id, sessionId);
	db.prepare(
		`
		UPDATE incoming_messages
		SET status = 'claimed', claimed_at = ?
		WHERE id = ?
		`,
	).run(now, row.id);
	return { id: row.id, content: row.content };
}

export function readLatestPendingIncomingMessage(db: SqliteDatabase, sessionId: string): IncomingRow | undefined {
	return db
		.prepare(
			`
			SELECT id, content, target_session_id
			FROM incoming_messages
			WHERE status = 'pending' AND (target_session_id = ? OR target_session_id IS NULL)
			ORDER BY id DESC
			LIMIT 1
			`,
		)
		.get(sessionId) as IncomingRow | undefined;
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
