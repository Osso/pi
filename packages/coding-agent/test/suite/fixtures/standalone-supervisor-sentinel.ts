import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { listRuntimeMailboxMessages } from "../../../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../../../src/core/sqlite.ts";

export interface StandaloneSupervisorSentinel {
	read(): {
		connections: number;
		starts: number;
		requests: number;
		listeners: number;
		cursors: number;
		agents: number;
	};
	close(): Promise<void>;
}

export async function startStandaloneSupervisorSentinel(controlDbPath: string): Promise<StandaloneSupervisorSentinel> {
	// Initialize the production schema in the parent, without registering a runtime or resident.
	listRuntimeMailboxMessages(controlDbPath);
	let connections = 0;
	const servers: Server[] = [];
	for (const suffix of [".supervisor-console.sock", ".supervisor.sock"]) {
		const server = createServer((socket) => {
			connections++;
			socket.destroy();
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(`${controlDbPath}${suffix}`, resolve);
		});
		servers.push(server);
	}
	return {
		read() {
			const startsPath = `${controlDbPath}.supervisor-starts`;
			const starts = existsSync(startsPath) ? readFileSync(startsPath, "utf8").trim().split("\n").length : 0;
			const db = createSqliteDatabase(controlDbPath);
			try {
				const count = (table: string): number =>
					(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
				return {
					connections,
					starts,
					requests: count("supervisor_requests"),
					listeners: count("runtime_mailbox_listeners"),
					cursors: count("shared_channel_cursors"),
					agents: count("multi_agent_agents"),
				};
			} finally {
				db.close();
			}
		},
		async close() {
			await Promise.all(
				servers.map(
					(server) =>
						new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
				),
			);
		},
	};
}
