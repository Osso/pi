import type { AgentSnapshot } from "../multi-agent-store.ts";
import { parseStoredJsonObject, validatePersistedAgentPayload } from "./codecs.ts";
import { withControlDb } from "./connection.ts";

export interface DetachedArtifactAgentRecord {
	sessionPath: string;
	agent: AgentSnapshot;
}

export function listDetachedArtifactAgentsUpdatedAtOrBefore(
	controlDbPath: string,
	updatedAtCutoff: string,
): DetachedArtifactAgentRecord[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(
				`SELECT session_path, agent_id, data
				 FROM multi_agent_agents
				 WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.updatedAt') END <= ?
				   AND json_extract(data, '$.lifecycle') IN ('completed', 'failed', 'aborted')
				   AND EXISTS (
				     SELECT 1
				     FROM json_each(data, '$.result.fileRefs') AS file_ref
				     WHERE json_extract(file_ref.value, '$.label') IN ('Bash output', 'Pyrun output')
				   )
				 ORDER BY CASE WHEN json_valid(data) THEN json_extract(data, '$.updatedAt') END,
				          session_path,
				          agent_id`,
			)
			.all(updatedAtCutoff) as Array<{ agent_id: string; data: string; session_path: string }>;
		return rows.map((row) => {
			const context = `multi_agent_agents:${row.session_path}#${row.agent_id}`;
			const agent = parseStoredJsonObject(row.data, context);
			validatePersistedAgentPayload(agent, context);
			return { agent: agent as unknown as AgentSnapshot, sessionPath: row.session_path };
		});
	});
}
