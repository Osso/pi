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
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_STATE_DIR } from "../../src/config.ts";
import { ensureRelayRunning, type RelayLaunchInvocation } from "../../src/core/host-relay-resident.ts";
import { isProcessIdentityAlive, type ProcessIdentity } from "../../src/core/runtime-process.ts";
import { getControlDbPath } from "../../src/core/session-control-db.ts";
import { ensureSupervisorAvailable } from "../../src/supervisor/ensure-running.ts";

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

function relayInvocation(command: string, agentDir: string, homeDir: string): RelayLaunchInvocation {
	const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
	return {
		command,
		args: ["--experimental-strip-types", cliPath, "relay", "connect"],
		env: {
			PATH: process.env.PATH,
			HOME: homeDir,
			[ENV_AGENT_DIR]: agentDir,
			[ENV_STATE_DIR]: agentDir,
			PI_SKIP_VERSION_CHECK: "1",
		},
	};
}

describe("relay automatic startup runtime", () => {
	it("starts a stopped relay when a session addresses the Supervisor on another host", async () => {
		const cacheDir = join(homedir(), ".cache");
		mkdirSync(cacheDir, { recursive: true });
		const tempDir = mkdtempSync(join(cacheDir, "pi-relay-supervisor-"));
		const agentDir = join(tempDir, "agent");
		const homeDir = join(tempDir, "home");
		for (const dir of [agentDir, homeDir]) mkdirSync(dir, { recursive: true });
		const supervisor = { sessionId: "remote-supervisor", host: "supervisor-host.invalid" };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ relay: relaySettings, supervisor }));
		const controlDbPath = getControlDbPath(agentDir);
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		let relay: ProcessIdentity | undefined;
		try {
			const address = await ensureSupervisorAvailable({
				controlDbPath,
				startRelay: (path, settings) =>
					ensureRelayRunning(path, settings, relayInvocation(process.execPath, agentDir, homeDir)),
			});
			relay = readRelayIdentity(controlDbPath);

			expect(address).toEqual(supervisor);
			expect(isProcessIdentityAlive(relay)).toBe(true);
		} finally {
			if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousAgentDir;
			await stopRelay(relay);
			rmSync(tempDir, { force: true, recursive: true });
		}
	}, 30_000);

	it.skipIf(process.platform !== "linux")(
		"replaces a same-version relay whose executable a deployment removed",
		async () => {
			// The copied node binary runs; keep it out of tmpfs scratch dirs, where Sentinel flags executables.
			const cacheDir = join(homedir(), ".cache");
			mkdirSync(cacheDir, { recursive: true });
			const tempDir = mkdtempSync(join(cacheDir, "pi-relay-runtime-"));
			const agentDir = join(tempDir, "agent");
			const homeDir = join(tempDir, "home");
			for (const dir of [agentDir, homeDir]) mkdirSync(dir, { recursive: true });
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ relay: relaySettings }));
			const controlDbPath = getControlDbPath(agentDir);
			const invocation = (command: string) => relayInvocation(command, agentDir, homeDir);
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
