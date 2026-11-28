import { isSandboxProfileName, type SandboxProfileName } from "../permissions/presets.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { withControlDb } from "./connection.ts";
import { normalizeSessionName } from "./helpers.ts";
import type { ResumeSessionMetadataOptions, SessionMetadata, WritableSessionMetadata } from "./types.ts";

export type SessionMetadataRow = {
	session_path: string;
	id: string;
	cwd: string;
	name: string | null;
	parent_session_path: string | null;
	archived_at: string | null;
	goal_json: string | null;
	is_subagent: number;
	subagent_name: string | null;
	model_provider: string | null;
	model_id: string | null;
	thinking_level: string | null;
	created_at: string;
	modified_at: string;
	message_count: number;
	first_message: string;
	updated_at: string;
};

export type SessionMetadataPreservedRow = {
	name: string | null;
	archived_at: string | null;
	goal_json: string | null;
	is_subagent: number;
	subagent_name: string | null;
	model_provider: string | null;
	model_id: string | null;
	thinking_level: string | null;
};

export type GoalRow = {
	goal_json: string | null;
};

export interface SessionMetadataWriteValues {
	name: string | undefined;
	archivedAt: string | null;
	isSubagent: boolean;
	subagentName: string | null;
	modelProvider: string | null;
	modelId: string | null;
	thinkingLevel: string | null;
}

export const UPSERT_SESSION_METADATA_SQL = `
	INSERT INTO session_metadata (
		session_path,
		id,
		cwd,
		name,
		name_revision,
		parent_session_path,
		archived_at,
		goal_json,
		is_subagent,
		subagent_name,
		model_provider,
		model_id,
		thinking_level,
		created_at,
		modified_at,
		message_count,
		first_message,
		updated_at
	)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(session_path) DO UPDATE SET
		id = excluded.id,
		cwd = excluded.cwd,
		name = CASE WHEN excluded.name_revision > 0 THEN excluded.name ELSE session_metadata.name END,
		name_revision = session_metadata.name_revision + excluded.name_revision,
		parent_session_path = excluded.parent_session_path,
		archived_at = excluded.archived_at,
		is_subagent = excluded.is_subagent,
		subagent_name = excluded.subagent_name,
		model_provider = excluded.model_provider,
		model_id = excluded.model_id,
		thinking_level = excluded.thinking_level,
		created_at = excluded.created_at,
		modified_at = excluded.modified_at,
		message_count = excluded.message_count,
		first_message = excluded.first_message,
		updated_at = excluded.updated_at
`;

export function readSessionMetadataWriteValues(
	db: SqliteDatabase,
	metadata: WritableSessionMetadata,
): SessionMetadataWriteValues {
	const preserved = readPreservedSessionMetadata(db, metadata.sessionPath);
	const preservedIsSubagent = preserved?.is_subagent === 1;
	return {
		name: metadata.name === undefined ? undefined : (normalizeSessionName(metadata.name) ?? ""),
		archivedAt: metadata.archivedAt ?? preserved?.archived_at ?? null,
		isSubagent: metadata.isSubagent ?? preservedIsSubagent,
		subagentName: metadata.subagentName ?? preserved?.subagent_name ?? null,
		modelProvider: metadata.modelProvider ?? preserved?.model_provider ?? null,
		modelId: metadata.modelId ?? preserved?.model_id ?? null,
		thinkingLevel: metadata.thinkingLevel ?? preserved?.thinking_level ?? null,
	};
}

export function writeSessionMetadataRow(
	db: SqliteDatabase,
	metadata: WritableSessionMetadata,
	values: SessionMetadataWriteValues,
): void {
	db.prepare(UPSERT_SESSION_METADATA_SQL).run(
		metadata.sessionPath,
		metadata.id,
		metadata.cwd,
		values.name ?? null,
		values.name === undefined ? 0 : 1,
		metadata.parentSessionPath ?? null,
		values.archivedAt,
		null,
		values.isSubagent ? 1 : 0,
		values.subagentName,
		values.modelProvider,
		values.modelId,
		values.thinkingLevel,
		metadata.createdAt,
		metadata.modifiedAt,
		metadata.messageCount,
		metadata.firstMessage,
		new Date().toISOString(),
	);
}

export function writeSessionMetadata(controlDbPath: string, metadata: WritableSessionMetadata): void {
	withControlDb(controlDbPath, (db) => {
		const values = readSessionMetadataWriteValues(db, metadata);
		writeSessionMetadataRow(db, metadata, values);
	});
}

export function readPreservedSessionMetadata(
	db: SqliteDatabase,
	sessionPath: string,
): SessionMetadataPreservedRow | undefined {
	return db
		.prepare(
			`
			SELECT name, archived_at, goal_json, is_subagent, subagent_name, model_provider, model_id, thinking_level
			FROM session_metadata
			WHERE session_path = ?
			`,
		)
		.get(sessionPath) as SessionMetadataPreservedRow | undefined;
}

export function writeSessionModel(controlDbPath: string, sessionPath: string, provider: string, modelId: string): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`UPDATE session_metadata
			 SET model_provider = ?, model_id = ?, updated_at = ?
			 WHERE session_path = ?`,
		).run(provider, modelId, new Date().toISOString(), sessionPath);
	});
}

export function writeSessionThinkingLevel(controlDbPath: string, sessionPath: string, thinkingLevel: string): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`UPDATE session_metadata
			 SET thinking_level = ?, updated_at = ?
			 WHERE session_path = ?`,
		).run(thinkingLevel, new Date().toISOString(), sessionPath);
	});
}

export function assertSessionMetadataIdentity(db: SqliteDatabase, sessionPath: string, sessionId: string): void {
	const row = db.prepare("SELECT id FROM session_metadata WHERE session_path = ?").get(sessionPath) as
		| { id: string }
		| undefined;
	if (!row) {
		throw new Error(`Session metadata is missing for ${sessionPath}`);
	}
	if (row.id !== sessionId) {
		throw new Error(`Session identity mismatch for ${sessionPath}: expected ${row.id}, received ${sessionId}`);
	}
}

export function writeSessionSandboxProfile(
	controlDbPath: string,
	sessionPath: string,
	sessionId: string,
	profile: SandboxProfileName,
): void {
	if (!isSandboxProfileName(profile)) {
		throw new Error(`Invalid sandbox profile '${profile}' for session ${sessionId}`);
	}
	withControlDb(controlDbPath, (db) => {
		assertSessionMetadataIdentity(db, sessionPath, sessionId);
		db.prepare(
			`INSERT INTO session_sandbox_profiles (session_path, session_id, profile, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(session_path) DO UPDATE SET
				session_id = excluded.session_id,
				profile = excluded.profile,
				updated_at = excluded.updated_at`,
		).run(sessionPath, sessionId, profile, new Date().toISOString());
	});
}

export function clearSessionSandboxProfile(controlDbPath: string, sessionPath: string, sessionId: string): void {
	withControlDb(controlDbPath, (db) => {
		assertSessionMetadataIdentity(db, sessionPath, sessionId);
		db.prepare("DELETE FROM session_sandbox_profiles WHERE session_path = ? AND session_id = ?").run(
			sessionPath,
			sessionId,
		);
	});
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

export const SESSION_METADATA_COLUMNS = `
	session_path,
	id,
	cwd,
	name,
	parent_session_path,
	archived_at,
	goal_json,
	is_subagent,
	subagent_name,
	model_provider,
	model_id,
	thinking_level,
	created_at,
	modified_at,
	message_count,
	first_message,
	updated_at`;

export function readSessionMetadata(controlDbPath: string, sessionPath: string): SessionMetadata | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`
				SELECT ${SESSION_METADATA_COLUMNS}
				FROM session_metadata
				WHERE session_path = ?
				`,
			)
			.get(sessionPath) as SessionMetadataRow | undefined;
		return row ? sessionMetadataFromRow(row) : undefined;
	});
}

export function listSessionMetadata(controlDbPath: string): SessionMetadata[] {
	return listSessionMetadataByArchiveState(controlDbPath);
}

export function listEmptyMainSessionCandidates(controlDbPath: string): Pick<SessionMetadata, "id" | "sessionPath">[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`SELECT id, session_path FROM session_metadata
				 WHERE archived_at IS NULL AND is_subagent = 0 AND message_count = 0`,
			)
			.all() as Pick<SessionMetadataRow, "id" | "session_path">[];
		return rows.map((row) => ({ id: row.id, sessionPath: row.session_path }));
	});
}

export function listActiveSessionMetadata(controlDbPath: string): SessionMetadata[] {
	return listSessionMetadataByArchiveState(controlDbPath, false);
}

/** Non-archived sessions that are not sub-agents, newest first; reads only the main-session index. */
export function listActiveMainSessionMetadata(controlDbPath: string): SessionMetadata[] {
	return withControlDb(controlDbPath, (db) =>
		(
			db
				.prepare(
					`SELECT ${SESSION_METADATA_COLUMNS} FROM session_metadata
					 WHERE archived_at IS NULL AND is_subagent = 0
					 ORDER BY modified_at DESC, updated_at DESC, session_path DESC`,
				)
				.all() as SessionMetadataRow[]
		).map(sessionMetadataFromRow),
	);
}

export function listArchivedSessionMetadata(controlDbPath: string): SessionMetadata[] {
	return listSessionMetadataByArchiveState(controlDbPath, true);
}

/** Whether every transcript under a session root has been indexed once; the index is authoritative only then. */
export function isSessionRootIndexed(controlDbPath: string, root: string): boolean {
	return withControlDb(
		controlDbPath,
		(db) => db.prepare("SELECT 1 FROM session_metadata_indexed_roots WHERE root = ?").get(root) !== undefined,
	);
}

export function markSessionRootIndexed(controlDbPath: string, root: string): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare("INSERT OR IGNORE INTO session_metadata_indexed_roots (root, indexed_at) VALUES (?, ?)").run(
			root,
			new Date().toISOString(),
		);
	});
}

export function listResumeSessionMetadata(
	controlDbPath: string,
	options: ResumeSessionMetadataOptions,
): SessionMetadata[] {
	return withControlDb(controlDbPath, (db) => {
		const predicates = [options.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL", "is_subagent = 0"];
		const values: string[] = [];
		if (options.cwd) {
			predicates.push("cwd = ?");
			values.push(options.cwd);
		}
		if (options.sessionPathPrefix) {
			predicates.push("substr(session_path, 1, length(?)) = ?");
			values.push(options.sessionPathPrefix, options.sessionPathPrefix);
		}

		const rows = db
			.prepare(
				`
				SELECT ${SESSION_METADATA_COLUMNS}
				FROM session_metadata
				WHERE ${predicates.join(" AND ")}
				ORDER BY modified_at DESC, updated_at DESC, session_path DESC
				`,
			)
			.all(...values) as SessionMetadataRow[];
		return rows.map(sessionMetadataFromRow);
	});
}

export function findActiveSessionMetadataById(controlDbPath: string, id: string): SessionMetadata[] {
	return findActiveSessionMetadata(controlDbPath, "id", id);
}

export function findActiveSessionMetadataByName(controlDbPath: string, name: string): SessionMetadata[] {
	return findActiveSessionMetadata(controlDbPath, "name", name);
}

export function findActiveSessionMetadata(
	controlDbPath: string,
	field: "id" | "name",
	value: string,
): SessionMetadata[] {
	return withControlDb(controlDbPath, (db) => {
		const matchClause = field === "id" ? "id >= ? AND id < ?" : "name = ?";
		const values = field === "id" ? [value, `${value}\uffff`] : [value];
		const rows = db
			.prepare(
				`
				SELECT ${SESSION_METADATA_COLUMNS}
				FROM session_metadata
				WHERE archived_at IS NULL AND is_subagent = 0 AND ${matchClause}
				ORDER BY modified_at DESC, updated_at DESC, session_path DESC
				`,
			)
			.all(...values) as SessionMetadataRow[];
		return rows.map(sessionMetadataFromRow);
	});
}

export function listSessionMetadataByArchiveState(controlDbPath: string, archived?: boolean): SessionMetadata[] {
	return withControlDb(controlDbPath, (db) => {
		const archiveClause =
			archived === undefined ? "" : archived ? "WHERE archived_at IS NOT NULL" : "WHERE archived_at IS NULL";
		const rows = db
			.prepare(
				`
				SELECT ${SESSION_METADATA_COLUMNS}
				FROM session_metadata
				${archiveClause}
				ORDER BY modified_at DESC, updated_at DESC, session_path DESC
				`,
			)
			.all() as SessionMetadataRow[];
		return rows.map(sessionMetadataFromRow);
	});
}

export function sessionMetadataFromRow(row: SessionMetadataRow): SessionMetadata {
	return {
		sessionPath: row.session_path,
		id: row.id,
		cwd: row.cwd,
		name: normalizeSessionName(row.name ?? undefined),
		parentSessionPath: row.parent_session_path ?? undefined,
		archivedAt: row.archived_at ?? undefined,
		isArchived: row.archived_at !== null,
		goalJson: row.goal_json ?? undefined,
		isSubagent: row.is_subagent === 1,
		subagentName: row.subagent_name ?? undefined,
		modelProvider: row.model_provider ?? undefined,
		modelId: row.model_id ?? undefined,
		thinkingLevel: row.thinking_level ?? undefined,
		createdAt: row.created_at,
		modifiedAt: row.modified_at,
		messageCount: row.message_count,
		firstMessage: row.first_message,
		updatedAt: row.updated_at,
	};
}
