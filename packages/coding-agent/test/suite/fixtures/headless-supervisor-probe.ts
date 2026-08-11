import { randomUUID } from "node:crypto";
import { VERSION } from "../../../src/config.ts";
import { ResidentConsoleServer } from "../../../src/core/resident-console-transport.ts";

export interface HeadlessSupervisorProbe {
	close(): Promise<void>;
}

export async function startHeadlessSupervisorProbe(controlDbPath: string): Promise<HeadlessSupervisorProbe> {
	const instanceId = randomUUID();
	const server = new ResidentConsoleServer<never, never>({
		socketPath: `${controlDbPath}.supervisor-console.sock`,
		service: "supervisor",
		getSnapshot: () => ({
			service: "supervisor",
			sessionId: "headless-supervisor",
			cwd: process.cwd(),
			generation: process.pid,
			identity: {
				version: VERSION,
				pid: process.pid,
				executable: process.execPath,
				...(process.argv[1] ? { entrypoint: process.argv[1] } : {}),
				instanceId,
				managedBy: "external",
				ready: true,
			},
			branch: [],
		}),
		enqueuePrompt: () => {},
		subscribe: () => () => {},
	});
	await server.start();
	return server;
}
