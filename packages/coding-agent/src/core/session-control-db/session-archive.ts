import { withControlDb } from "./connection.ts";

export function archiveSession(controlDbPath: string, sessionPath: string): void {
	withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		db.prepare("UPDATE session_metadata SET archived_at = ?, updated_at = ? WHERE session_path = ?").run(
			now,
			now,
			sessionPath,
		);
	});
}

export function unarchiveSession(controlDbPath: string, sessionPath: string): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare("UPDATE session_metadata SET archived_at = NULL, updated_at = ? WHERE session_path = ?").run(
			new Date().toISOString(),
			sessionPath,
		);
	});
}

export function archiveSessionsOlderThan(controlDbPath: string, cutoff: Date): string[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`SELECT session_path, modified_at
				 FROM session_metadata
				 WHERE archived_at IS NULL AND is_subagent = 0 AND modified_at < ?`,
			)
			.all(cutoff.toISOString()) as Array<{ modified_at: string; session_path: string }>;
		return rows.sort(compareArchivedSessionRows).map((row) => row.session_path);
	});
}

export function compareArchivedSessionRows(
	left: { modified_at: string; session_path: string },
	right: { modified_at: string; session_path: string },
): number {
	if (left.modified_at !== right.modified_at) return left.modified_at < right.modified_at ? -1 : 1;
	if (left.session_path === right.session_path) return 0;
	return left.session_path < right.session_path ? -1 : 1;
}
