import { TERMINAL_STATES } from "../core/multi-agent-types.ts";
import { withControlDb } from "../core/session-control-db/connection.ts";

/** A sub-agent of a running session that has not reached a terminal lifecycle, as session summaries carry it. */
export type ServerSessionAgent = {
	id: string;
	/** `"main"` for a direct child of the session's main thread. */
	parentId: string | null;
	displayName: string;
	agentType: string;
	lifecycle: string;
	/** `"thinking"`, `"<tool>: <detail>"` or the tool name while it acts, else its last activity, else `""`. */
	activity: string;
};

type ActiveAgentRow = {
	session_path: string;
	agent_id: string;
	parent_id: string | null;
	display_name: string;
	agent_type: string;
	lifecycle: string;
	phase: string | null;
	tool_name: string | null;
	detail: string | null;
	last_description: string | null;
};

// The multi-agent store of every Pi process on the machine (server workers and terminal sessions) lives here.
const ACTIVE_AGENTS_SQL = `SELECT session_path, agent_id,
		json_extract(data, '$.parentId') AS parent_id,
		json_extract(data, '$.displayName') AS display_name,
		json_extract(data, '$.agentType') AS agent_type,
		json_extract(data, '$.lifecycle') AS lifecycle,
		json_extract(data, '$.currentActivity.phase') AS phase,
		json_extract(data, '$.currentActivity.toolName') AS tool_name,
		json_extract(data, '$.currentActivity.detail') AS detail,
		json_extract(data, '$.lastActivity.description') AS last_description
	FROM multi_agent_agents
	WHERE session_path IN (SELECT value FROM json_each(?)) AND json_valid(data)
		AND json_extract(data, '$.lifecycle') NOT IN (SELECT value FROM json_each(?))
	ORDER BY session_path, json_extract(data, '$.createdAt'), agent_id`;

function describeActivity(row: ActiveAgentRow): string {
	if (row.phase === "thinking") return "thinking";
	if (row.phase === "tool" && row.tool_name) return row.detail ? `${row.tool_name}: ${row.detail}` : row.tool_name;
	return row.last_description ?? "";
}

/** The non-terminal sub-agents of each given session file, in creation order; sessions without any are absent. */
export function readActiveSessionAgents(
	controlDbPath: string,
	sessionPaths: string[],
): Map<string, ServerSessionAgent[]> {
	const bySession = new Map<string, ServerSessionAgent[]>();
	if (sessionPaths.length === 0) return bySession;
	const rows = withControlDb(
		controlDbPath,
		(db) =>
			db
				.prepare(ACTIVE_AGENTS_SQL)
				.all(JSON.stringify(sessionPaths), JSON.stringify([...TERMINAL_STATES])) as ActiveAgentRow[],
	);
	for (const row of rows) {
		const agents = bySession.get(row.session_path) ?? [];
		agents.push({
			id: row.agent_id,
			parentId: row.parent_id,
			displayName: row.display_name,
			agentType: row.agent_type,
			lifecycle: row.lifecycle,
			activity: describeActivity(row),
		});
		bySession.set(row.session_path, agents);
	}
	return bySession;
}
