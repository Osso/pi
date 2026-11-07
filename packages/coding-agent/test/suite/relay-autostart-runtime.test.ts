import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_STATE_DIR } from "../../src/config.ts";
import { ensureRelayRunning, type RelayLaunchInvocation } from "../../src/core/host-relay-resident.ts";
import { isProcessIdentityAlive, type ProcessIdentity } from "../../src/core/runtime-process.ts";
import { getControlDbPath } from "../../src/core/session-control-db.ts";

// `.invalid` never resolves, so the relay keeps retrying its SSH connection without network access.
const relaySettings = { peer: "relay-test.invalid" };

function readRelayIdentity(controlDbPath: string): ProcessIdentity {
	const { pid, startTimeTicks } = JSON.parse(readFileSync(`${controlDbPath}.relay.json`, "utf8")) as ProcessIdentity;
	return { pid, startTimeTicks };
}

async function waitForExit(identity: ProcessIdentity): Promise<boolean> {
	const deadline = Date.now() + 5_000;
	while (isProcessIdentityAlive(identity) && Date.now() < deadline) await delay(25);
	return !isProcessIdentityAlive(identity);
}

async function stopRelay(identity: ProcessIdentity | undefined): Promise<void> {
	if (!identity || !isProcessIdentityAlive(identity)) return;
	process.kill(identity.pid, "SIGTERM");
	if (!(await waitForExit(identity))) process.kill(identity.pid, "SIGKILL");
}

describe("relay automatic startup runtime", () => {
	it.skipIf(process.platform !== "linux")(
		"replaces a same-version relay whose executable a deployment removed",
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "pi-relay-runtime-"));
			const agentDir = join(tempDir, "agent");
			const homeDir = join(tempDir, "home");
			for (const dir of [agentDir, homeDir]) mkdirSync(dir, { recursive: true });
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ relay: relaySettings }));
			const controlDbPath = getControlDbPath(agentDir);
			const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
			const invocation = (command: string): RelayLaunchInvocation => ({
				command,
				args: ["--experimental-strip-types", cliPath, "relay", "connect"],
				env: {
					PATH: process.env.PATH,
					HOME: homeDir,
					[ENV_AGENT_DIR]: agentDir,
					[ENV_STATE_DIR]: agentDir,
					PI_SKIP_VERSION_CHECK: "1",
				},
			});
			const deployedNode = join(tempDir, "node");
			copyFileSync(process.execPath, deployedNode);
			chmodSync(deployedNode, 0o755);
			let stale: ProcessIdentity | undefined;
			let current: ProcessIdentity | undefined;
			try {
				await ensureRelayRunning(controlDbPath, relaySettings, invocation(deployedNode));
				stale = readRelayIdentity(controlDbPath);
				rmSync(deployedNode);
				expect(readlinkSync(`/proc/${stale.pid}/exe`)).toBe(`${deployedNode} (deleted)`);

				await ensureRelayRunning(controlDbPath, relaySettings, invocation(process.execPath));
				current = readRelayIdentity(controlDbPath);

				expect(current.pid).not.toBe(stale.pid);
				expect(await waitForExit(stale)).toBe(true);
				expect(readlinkSync(`/proc/${current.pid}/exe`)).toBe(process.execPath);
				await ensureRelayRunning(controlDbPath, relaySettings, invocation(process.execPath));
				expect(readRelayIdentity(controlDbPath)).toEqual(current);
			} finally {
				await stopRelay(stale);
				await stopRelay(current);
				rmSync(tempDir, { force: true, recursive: true });
			}
		},
		30_000,
	);
});
