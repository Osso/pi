import { isSandboxProfileName, type SandboxProfileName } from "../permissions/presets.ts";

import { withControlDb } from "./connection.ts";
import { assertSessionMetadataIdentity } from "./session-metadata.ts";

export type SessionSandboxProfileRow = {
	profile: string;
	session_id: string;
};

export function readSessionSandboxProfile(
	controlDbPath: string,
	sessionPath: string,
	sessionId: string,
): SandboxProfileName | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare("SELECT session_id, profile FROM session_sandbox_profiles WHERE session_path = ?")
			.get(sessionPath) as SessionSandboxProfileRow | undefined;
		if (!row) return undefined;
		assertSessionMetadataIdentity(db, sessionPath, sessionId);
		if (row.session_id !== sessionId) {
			throw new Error(
				`Session identity mismatch for ${sessionPath}: stored ${row.session_id}, received ${sessionId}`,
			);
		}
		if (!isSandboxProfileName(row.profile)) {
			throw new Error(`Invalid sandbox profile '${row.profile}' for session ${sessionId}`);
		}
		return row.profile;
	});
}
