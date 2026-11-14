import { join } from "node:path";
import { getUserStateRoot } from "../../config.ts";
import { withControlDb } from "./connection.ts";

export function getControlDbPath(directory = getUserStateRoot()): string {
	return join(directory, "control.sqlite");
}

/** Claims one recovery attempt per explicit request, independent of transcript ancestry. */

export function claimCodexRestrictionRecovery(controlDbPath: string, userRequestId: string): boolean {
	if (userRequestId.trim().length === 0) throw new Error("Codex restriction recovery request ID must not be empty");
	return withControlDb(controlDbPath, (db) => {
		const result = db
			.prepare(
				`
				INSERT INTO codex_restriction_recovery_claims (user_request_id, claimed_at)
				VALUES (?, ?)
				ON CONFLICT(user_request_id) DO NOTHING
				`,
			)
			.run(userRequestId, new Date().toISOString());
		return result.changes === 1;
	});
}

/** Queues a control message; a target session ID reserves it for that session, otherwise any session may claim it. */

export function readRunningSessionIdByPid(controlDbPath: string, pid: number): string | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`
				SELECT session_id
				FROM session_health
				WHERE pid = ? AND check_status = 'ok'
				ORDER BY updated_at DESC
				LIMIT 1
				`,
			)
			.get(pid) as { session_id: string } | undefined;
		return row?.session_id;
	});
}

/**
 * Claims the newest pending message addressed to this session or to no session, and supersedes the other pending
 * messages this session could claim. Messages addressed to other sessions stay pending for them.
 */

export function isKnownLocalSession(controlDbPath: string, sessionId: string): boolean {
	return withControlDb(controlDbPath, (db) =>
		Boolean(
			db
				.prepare(
					"SELECT 1 FROM session_metadata WHERE id = ? UNION ALL SELECT 1 FROM session_health WHERE session_id = ? LIMIT 1",
				)
				.get(sessionId, sessionId),
		),
	);
}
