import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_STATE_DIR, VERSION } from "../../src/config.ts";
import type { ResidentConsoleIdentity } from "../../src/core/resident-console-transport.ts";
import { getControlDbPath } from "../../src/core/session-control-db.ts";
import { ensureSupervisorRunning } from "../../src/supervisor/ensure-running.ts";

const tempDirs: string[] = [];
const startedSupervisors: ResidentConsoleIdentity[] = [];

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processIsAlive(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !processIsAlive(pid);
}

async function terminateSupervisorProcess(pid: number): Promise<void> {
	process.kill(pid, "SIGTERM");
	if (await waitForProcessExit(pid)) return;
	process.kill(pid, "SIGKILL");
	if (!(await waitForProcessExit(pid, 1_000))) throw new Error(`Supervisor process ${pid} did not exit`);
}

afterEach(async () => {
	for (const supervisor of startedSupervisors.splice(0)) {
		if (!processIsAlive(supervisor.pid)) continue;
		await terminateSupervisorProcess(supervisor.pid);
	}
	for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { force: true, recursive: true });
});

describe("Supervisor automatic startup runtime", () => {
	it("starts one detached resident and reuses it across concurrent callers", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-runtime-"));
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		const stateDir = join(tempDir, "state");
		const kbDir = join(tempDir, "kb");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(kbDir, { recursive: true });
		const controlDbPath = getControlDbPath(stateDir);
		const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
		const launchInvocation = {
			command: process.execPath,
			args: ["--experimental-strip-types", cliPath, "supervisor"],
			cwd: join(import.meta.dirname, "..", ".."),
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				[ENV_STATE_DIR]: stateDir,
				PI_KB_DIR: kbDir,
				PI_SKIP_VERSION_CHECK: "1",
				PI_SUPERVISOR_AUTOSTARTED: "1",
			},
		};

		const [first, second] = await Promise.all([
			ensureSupervisorRunning({ controlDbPath, launchInvocation, startupTimeoutMs: 10_000 }),
			ensureSupervisorRunning({ controlDbPath, launchInvocation, startupTimeoutMs: 10_000 }),
		]);
		startedSupervisors.push(first);

		expect(first).toMatchObject({
			version: VERSION,
			pid: expect.any(Number),
			instanceId: expect.any(String),
			managedBy: "pi",
			ready: true,
		});
		expect(second.pid).toBe(first.pid);
		expect(second.instanceId).toBe(first.instanceId);
		await expect(ensureSupervisorRunning({ controlDbPath, launchInvocation })).resolves.toMatchObject({
			pid: first.pid,
			instanceId: first.instanceId,
		});
	});
});
