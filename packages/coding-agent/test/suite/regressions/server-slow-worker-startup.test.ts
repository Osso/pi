import { describe, expect, it } from "vitest";
import { withHeadlessPi } from "../headless-pi.ts";
import { type Frame, startDaemon, stopDaemon } from "../server-daemon-fixture.ts";

// A worker resuming a ~900 MB session answered its first get_state after more than 30 s; pi server gave up
// on it ("RPC worker did not answer within 30 seconds") and dropped the session from the ones it restores.
describe("pi server slow worker startup", () => {
	it("waits for a worker that takes longer than 30 seconds to load", async () => {
		await withHeadlessPi(async (agent) => {
			// Only the daemon (and the workers it spawns) inherit the delay, not the harness's own agent.
			process.env.PI_TEST_RPC_WORKER_STARTUP_DELAY_MS = "32000";
			const { daemon, client, runtimeDir } = await startDaemon(agent, null).finally(() => {
				delete process.env.PI_TEST_RPC_WORKER_STARTUP_DELAY_MS;
			});
			try {
				const started = await client.request("start_session", { cwd: agent.paths.workspaceDir }, 60_000);
				expect(started.error).toBeUndefined();
				const { session } = started.data as { session: Frame };
				expect(session).toMatchObject({ owner: "server", attachment: "rpc" });
			} finally {
				client.close();
				await stopDaemon(daemon, runtimeDir);
			}
		});
	}, 90_000);
});
