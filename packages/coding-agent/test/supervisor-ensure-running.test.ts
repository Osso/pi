import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import { readProcessIdentity } from "../src/core/runtime-process.ts";
import { writeSessionHealth } from "../src/core/session-control-db/session-health.ts";
import { ensureSupervisorAvailable } from "../src/supervisor/ensure-running.ts";

const tempDirs: string[] = [];

function controlDbPath(): string {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-ensure-"));
	tempDirs.push(tempDir);
	return join(tempDir, "control.sqlite");
}

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { force: true, recursive: true });
});

describe("ensureSupervisorAvailable", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

	function configureSupervisorSession(sessionId?: string, host?: string): string {
		const path = controlDbPath();
		const agentDir = join(path, "..", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify(sessionId ? { supervisor: { sessionId, host } } : {}),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		return path;
	}

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	it("fails when no Supervisor session is configured", async () => {
		const path = configureSupervisorSession();
		await expect(ensureSupervisorAvailable({ controlDbPath: path })).rejects.toThrow(
			"no Supervisor session is configured; set supervisor.sessionId",
		);
	});

	it("fails fast when the configured session is not running", async () => {
		const path = configureSupervisorSession("supervisor-session");
		await expect(ensureSupervisorAvailable({ controlDbPath: path })).rejects.toThrow(
			"the Supervisor session supervisor-session is not running",
		);
	});

	it("accepts the configured session while its recorded Pi process is alive", async () => {
		const path = configureSupervisorSession("supervisor-session");
		const now = new Date().toISOString();
		writeSessionHealth(path, {
			sessionId: "supervisor-session",
			agentGeneration: 1,
			pid: process.pid,
			lastActiveAt: now,
			lastCheckedAt: now,
			checkStatus: "ok",
			checkedGeneration: 1,
			checkLatencyMs: 1,
			updatedAt: now,
		});
		await expect(ensureSupervisorAvailable({ controlDbPath: path })).resolves.toEqual({
			sessionId: "supervisor-session",
		});
	});

	it("addresses a Supervisor on another host while this host's relay runs", async () => {
		const path = configureSupervisorSession("supervisor-session", "supervisor-test-host");
		await expect(ensureSupervisorAvailable({ controlDbPath: path })).rejects.toThrow(
			"the relay to the Supervisor on host supervisor-test-host is not running",
		);

		writeFileSync(`${path}.relay.json`, JSON.stringify({ ...readProcessIdentity(process.pid), version: VERSION }));
		await expect(ensureSupervisorAvailable({ controlDbPath: path })).resolves.toEqual({
			sessionId: "supervisor-session",
			host: "supervisor-test-host",
		});
	});
});
