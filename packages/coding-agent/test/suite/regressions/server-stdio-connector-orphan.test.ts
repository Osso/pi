import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";
import { startDaemon, stopDaemon } from "../server-daemon-fixture.ts";

/** User + system CPU ticks of `pid` (Linux /proc). */
async function cpuTicks(pid: number): Promise<number> {
	const { readFile } = await import("node:fs/promises");
	const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).split(")").at(-1)?.trim().split(/\s+/) ?? [];
	return Number(fields[11]) + Number(fields[12]);
}

// Seen live: an SSH client of `pi server --stdio` went away. The next pushed update failed with EPIPE on stdout,
// the connector kept its server socket, and under Bun (the shipped runtime) it then spun a core for hours.
it.runIf(process.platform === "linux")(
	"pi server --stdio exits when its client goes away, after a push to the closed stdout",
	async () => {
		await withHeadlessPi(async (agent) => {
			const { daemon, client, runtimeDir } = await startDaemon(agent, null);
			const cliPath = join(import.meta.dirname, "../../../src/cli.ts");
			const connector = spawn("bun", [cliPath, "server", "--stdio"], {
				cwd: agent.paths.workspaceDir,
				env: {
					...process.env,
					XDG_RUNTIME_DIR: runtimeDir,
					PI_CODING_AGENT_DIR: agent.paths.agentDir,
					PI_CODING_AGENT_STATE_DIR: agent.paths.agentDir,
					PI_CODING_AGENT_SESSION_DIR: agent.paths.sessionDir,
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			const exited = new Promise<number | null>((resolve) => connector.once("exit", (code) => resolve(code)));
			try {
				const { stdin, stdout } = connector;
				if (!stdin || !stdout) throw new Error("stdio connector is not piped");
				const lines = createInterface({ input: stdout, crlfDelay: Infinity });
				const subscribed = new Promise<void>((resolve) =>
					lines.on("line", (line) => {
						if ((JSON.parse(line) as { id?: string }).id === "subscribe") resolve();
					}),
				);
				stdin.write(`${JSON.stringify({ id: "hello", type: "hello", version: 1 })}\n`);
				stdin.write(`${JSON.stringify({ id: "subscribe", type: "list_sessions" })}\n`);
				await subscribed;

				// The client goes away: its stdout first, then a session update is pushed, then its stdin.
				lines.close();
				stdout.destroy();
				// The first push fails with EPIPE; the later ones are left unread in the connector's socket.
				for (let push = 0; push < 3; push++) {
					const started = await client.request("start_session", { cwd: agent.paths.workspaceDir });
					expect(started.success).toBe(true);
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
				stdin.end();

				const code = await Promise.race([
					exited,
					new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 10_000)),
				]);
				if (code === "running" && connector.pid) {
					const before = await cpuTicks(connector.pid);
					await new Promise((resolve) => setTimeout(resolve, 1_000));
					throw new Error(
						`connector still running; CPU ticks in 1 s: ${(await cpuTicks(connector.pid)) - before}`,
					);
				}
				expect(code).not.toBe("running");
			} finally {
				connector.kill("SIGKILL");
				client.close();
				await stopDaemon(daemon, runtimeDir);
			}
		});
	},
	60_000,
);
