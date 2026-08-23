import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionMetadata } from "../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

function createVersionFourteenDatabase(controlDbPath: string): void {
	const db = createSqliteDatabase(controlDbPath);
	try {
		db.exec(`
			CREATE TABLE session_metadata (
				session_path TEXT PRIMARY KEY,
				id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				name TEXT,
				parent_session_path TEXT,
				archived_at TEXT,
				goal_json TEXT,
				is_subagent INTEGER NOT NULL DEFAULT 0,
				subagent_name TEXT,
				model_provider TEXT,
				model_id TEXT,
				thinking_level TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				message_count INTEGER NOT NULL,
				first_message TEXT NOT NULL,
				all_messages_text TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE named_sessions (
				session_path TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			INSERT INTO session_metadata (
				session_path, id, cwd, name, created_at, modified_at,
				message_count, first_message, all_messages_text, updated_at
			) VALUES
				('/sessions/legacy-name.jsonl', 'legacy-name', '/repo', 'Metadata Name',
				 '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z', 1, 'first', 'first',
				 '2026-08-01T00:01:00.000Z'),
				('/sessions/metadata-only.jsonl', 'metadata-only', '/repo', 'Metadata Only',
				 '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z', 1, 'first', 'first',
				 '2026-08-01T00:01:00.000Z');
			INSERT INTO named_sessions (session_path, name, updated_at)
			VALUES
				('/sessions/legacy-name.jsonl', ' Legacy\r\nPreferred\nName ', '2026-08-02T00:00:00.000Z'),
				('/sessions/orphan.jsonl', 'Orphan Name', '2026-08-02T00:00:00.000Z');
			PRAGMA user_version = 14;
		`);
	} finally {
		db.close();
	}
}

describe("session name schema migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("migrates normalized version 14 names into matching metadata and drops orphan legacy rows idempotently", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-name-migration-"));
		tempDirs.push(tempDir);
		const controlDbPath = join(tempDir, "control.sqlite");
		createVersionFourteenDatabase(controlDbPath);

		const firstInitialization = {
			legacyName: readSessionMetadata(controlDbPath, "/sessions/legacy-name.jsonl")?.name,
			metadataOnlyName: readSessionMetadata(controlDbPath, "/sessions/metadata-only.jsonl")?.name,
		};
		const secondInitialization = {
			legacyName: readSessionMetadata(controlDbPath, "/sessions/legacy-name.jsonl")?.name,
			metadataOnlyName: readSessionMetadata(controlDbPath, "/sessions/metadata-only.jsonl")?.name,
		};

		const db = createSqliteDatabase(controlDbPath);
		try {
			const schemaVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
			const legacyTable = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'named_sessions'")
				.get();
			const storedNames = db
				.prepare("SELECT session_path, name FROM session_metadata ORDER BY session_path")
				.all() as Array<{ session_path: string; name: string | null }>;

			expect({ firstInitialization, secondInitialization, schemaVersion, legacyTable, storedNames }).toEqual({
				firstInitialization: {
					legacyName: "Legacy Preferred Name",
					metadataOnlyName: "Metadata Only",
				},
				secondInitialization: {
					legacyName: "Legacy Preferred Name",
					metadataOnlyName: "Metadata Only",
				},
				schemaVersion: 15,
				legacyTable: undefined,
				storedNames: [
					{ session_path: "/sessions/legacy-name.jsonl", name: "Legacy Preferred Name" },
					{ session_path: "/sessions/metadata-only.jsonl", name: "Metadata Only" },
				],
			});
		} finally {
			db.close();
		}
	});

	it("requires runtime quiescence before dropping the legacy table", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-name-quiescence-"));
		tempDirs.push(tempDir);
		const controlDbPath = join(tempDir, "control.sqlite");
		createVersionFourteenDatabase(controlDbPath);
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE runtime_mailbox_listeners (
					recipient_session_id TEXT NOT NULL,
					recipient_agent_id_key TEXT NOT NULL,
					pid INTEGER NOT NULL,
					runtime_instance_id TEXT,
					session_path TEXT,
					session_path_asserted_at TEXT,
					updated_at TEXT NOT NULL,
					PRIMARY KEY (recipient_session_id, recipient_agent_id_key)
				);
			`);
			db.prepare(
				`INSERT INTO runtime_mailbox_listeners (
					recipient_session_id, recipient_agent_id_key, pid, updated_at
				) VALUES ('live-runtime', '', ?, '2026-08-23T00:00:00.000Z')`,
			).run(process.pid);
		} finally {
			db.close();
		}

		expect(() => readSessionMetadata(controlDbPath, "/sessions/legacy-name.jsonl")).toThrow(
			/session name schema version 15.*lifecycle owners are active/i,
		);
		const blockedDb = createSqliteDatabase(controlDbPath);
		try {
			expect((blockedDb.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(14);
			expect(
				blockedDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'named_sessions'").get(),
			).toBeDefined();
			blockedDb.prepare("DELETE FROM runtime_mailbox_listeners WHERE recipient_session_id = 'live-runtime'").run();
		} finally {
			blockedDb.close();
		}

		expect(readSessionMetadata(controlDbPath, "/sessions/legacy-name.jsonl")?.name).toBe("Legacy Preferred Name");
	});
});
