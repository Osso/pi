import type { SqliteDatabase } from "../sqlite.ts";
import { withControlDb } from "./connection.ts";
import type { LastControlMessage, LastMessageRow, PromptHistoryRow } from "./types.ts";

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

export type PromptHistoryMigrationRow = { content: string; createdAt: string };

export function readOrMigratePromptHistory(controlDbPath: string, legacyEntries: string[], limit = 100): string[] {
	return withControlDb(controlDbPath, (db) => {
		const existingEntries = readPromptHistoryRows(db, limit);
		if (existingEntries.length > 0) return existingEntries;
		if (legacyEntries.length === 0) return [];
		const preparedRows = preparePromptHistoryMigrationRows(legacyEntries);
		if (preparedRows.length === 0) return legacyEntries.slice(0, limit);
		const inserted = insertPromptHistoryMigrationRows(db, preparedRows);
		if (inserted === preparedRows.length) return legacyEntries.slice(0, limit);
		if (inserted === 0) return readPromptHistoryRows(db, limit);
		throw new Error(`Prompt history migration inserted ${inserted} of ${preparedRows.length} prepared rows`);
	});
}

export function preparePromptHistoryMigrationRows(legacyEntries: string[]): PromptHistoryMigrationRow[] {
	const createdAt = new Date().toISOString();
	const rows: PromptHistoryMigrationRow[] = [];
	let previousContent: string | undefined;
	for (let index = legacyEntries.length - 1; index >= 0; index -= 1) {
		const content = legacyEntries[index]?.trim();
		if (!content || content === previousContent) continue;
		rows.push({ content, createdAt });
		previousContent = content;
	}
	return rows;
}

export function insertPromptHistoryMigrationRows(db: SqliteDatabase, rows: PromptHistoryMigrationRow[]): number {
	return db
		.prepare(
			`INSERT INTO prompt_history (content, created_at)
			 SELECT json_extract(value, '$.content'), json_extract(value, '$.createdAt')
			 FROM json_each(?)
			 WHERE NOT EXISTS (SELECT 1 FROM prompt_history)
			 ORDER BY CAST(key AS INTEGER)`,
		)
		.run(JSON.stringify(rows)).changes;
}

export function readPromptHistoryRows(db: SqliteDatabase, limit: number): string[] {
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

export function insertPromptHistoryEntry(db: SqliteDatabase, content: string): void {
	const trimmedContent = content.trim();
	if (!trimmedContent) return;
	if (readLatestPromptHistoryEntry(db) === trimmedContent) return;

	db.prepare(
		`
		INSERT INTO prompt_history (content, created_at)
		VALUES (?, ?)
		`,
	).run(trimmedContent, new Date().toISOString());
}

export function readLatestPromptHistoryEntry(db: SqliteDatabase): string | undefined {
	const row = db
		.prepare(
			`
			SELECT content
			FROM prompt_history
			ORDER BY id DESC
			LIMIT 1
			`,
		)
		.get() as PromptHistoryRow | undefined;
	return row?.content;
}
