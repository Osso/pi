import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { writeSessionHealth } from "../../../src/core/session-control-db/session-health.ts";

/** The Supervisor session test processes stand in for; requests are answered by the test itself. */
export const HEADLESS_SUPERVISOR_SESSION_ID = "headless-supervisor";

/** Settings entry that routes a fixture Pi's Supervisor requests to the stand-in session. */
export const HEADLESS_SUPERVISOR_SETTINGS = { supervisor: { sessionId: HEADLESS_SUPERVISOR_SESSION_ID } };

/**
 * Pi accepts a Supervisor session only while its recorded process runs a Pi entrypoint. A stand-in process
 * carries this path in its argv so the check passes without starting a real Pi session.
 */
export const PI_CLI_ENTRYPOINT = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");

export function writeHeadlessSupervisorHealth(controlDbPath: string, pid: number | null): void {
	const now = new Date().toISOString();
	writeSessionHealth(controlDbPath, {
		sessionId: HEADLESS_SUPERVISOR_SESSION_ID,
		agentGeneration: 1,
		pid,
		lastActiveAt: now,
		lastCheckedAt: now,
		checkStatus: pid === null ? "dead" : "ok",
		checkedGeneration: 1,
		checkLatencyMs: 1,
		updatedAt: now,
	});
}

export interface HeadlessSupervisor {
	/** Stops the stand-in Supervisor session, so new requests fail fast. */
	close(): Promise<void>;
}

/** Starts an idle stand-in process and records it as the running Supervisor session. */
export async function registerHeadlessSupervisor(controlDbPath: string): Promise<HeadlessSupervisor> {
	// The stand-in exits at EOF on its stdin pipe, which closes when the test process dies without close().
	const child: ChildProcess = spawn(
		process.execPath,
		["-e", 'process.stdin.on("end", () => process.exit(0)).resume()', PI_CLI_ENTRYPOINT],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	if (child.pid === undefined) throw new Error("Stand-in Supervisor process has no pid");
	writeHeadlessSupervisorHealth(controlDbPath, child.pid);
	return {
		async close() {
			writeHeadlessSupervisorHealth(controlDbPath, null);
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGKILL");
			await exited;
		},
	};
}
