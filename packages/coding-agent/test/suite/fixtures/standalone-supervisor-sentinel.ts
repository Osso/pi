import { listRuntimeMailboxMessages } from "../../../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../../../src/core/sqlite.ts";

export interface StandaloneSupervisorSentinel {
	read(): {
		requests: number;
		listeners: number;
		cursors: number;
		agents: number;
	};
	close(): Promise<void>;
}

/** Counts the control-DB state a standalone worker must never create. */
export async function startStandaloneSupervisorSentinel(controlDbPath: string): Promise<StandaloneSupervisorSentinel> {
	// Initialize the production schema in the parent, without registering a runtime.
	listRuntimeMailboxMessages(controlDbPath);
	return {
		read() {
			const db = createSqliteDatabase(controlDbPath);
			try {
				const count = (table: string): number =>
					(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
				return {
					requests: count("supervisor_requests"),
					listeners: count("runtime_mailbox_listeners"),
					cursors: count("shared_channel_cursors"),
					agents: count("multi_agent_agents"),
				};
			} finally {
				db.close();
			}
		},
		async close() {},
	};
}
