import { isProcessIdentityAlive, type ProcessIdentity } from "../../src/core/runtime-process.ts";
import {
	readMultiAgentRuntimeOwnership,
	readMultiAgentState,
	type MultiAgentRuntimeOwnership,
} from "../../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../../src/core/sqlite.ts";

export function forceRuntimeOwnership(
	controlDbPath: string,
	input: {
		agentId: string;
		owner: { agentId: string | null; sessionId: string };
		nowIso?: string;
		processIdentity: ProcessIdentity;
		sessionPath: string;
	},
): { ok: true; ownership: MultiAgentRuntimeOwnership } | { ok: false; error: "ownership_held" } {
	readMultiAgentState(controlDbPath, input.sessionPath);
	const current = readMultiAgentRuntimeOwnership(controlDbPath, input.sessionPath, input.agentId);
	if (current?.processIdentity && isProcessIdentityAlive(current.processIdentity)) {
		return { ok: false, error: "ownership_held" };
	}
	const db = createSqliteDatabase(controlDbPath);
	try {
		db.prepare(
			`INSERT INTO multi_agent_runtime_owners (
				session_path, agent_id, process_identity, owner_session_id, owner_agent_id
			) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(session_path, agent_id) DO UPDATE SET
				process_identity = excluded.process_identity,
				owner_session_id = excluded.owner_session_id,
				owner_agent_id = excluded.owner_agent_id`,
		).run(
			input.sessionPath,
			input.agentId,
			JSON.stringify(input.processIdentity),
			input.owner.sessionId,
			input.owner.agentId,
		);
	} finally {
		db.close();
	}
	const ownership = readMultiAgentRuntimeOwnership(controlDbPath, input.sessionPath, input.agentId);
	if (!ownership) throw new Error(`Test ownership did not persist ${input.sessionPath}#${input.agentId}`);
	return { ok: true, ownership };
}
