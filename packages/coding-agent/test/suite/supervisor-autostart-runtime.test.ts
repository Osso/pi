import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_STATE_DIR, VERSION } from "../../src/config.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { probeResidentConsole, type ResidentConsoleIdentity } from "../../src/core/resident-console-transport.ts";
import { isProcessIdentityAlive, type ProcessIdentity, readProcessIdentity } from "../../src/core/runtime-process.ts";
import { getControlDbPath } from "../../src/core/session-control-db.ts";
import { ensureSupervisorRunning, type SupervisorLaunchInvocation } from "../../src/supervisor/ensure-running.ts";

type ProcessReport =
	| { type: "started"; identity: ProcessIdentity; executable: string; bun: string | null }
	| { type: "request"; transport: string }
	| { type: "exit"; identity: ProcessIdentity; code: number; requests: number };

function readReports(path: string): ProcessReport[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ProcessReport);
}

async function waitForProcessExit(identity: ProcessIdentity, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessIdentityAlive(identity) && Date.now() < deadline) await delay(25);
	return !isProcessIdentityAlive(identity);
}

async function terminateSupervisorProcess(identity: ProcessIdentity): Promise<void> {
	if (!isProcessIdentityAlive(identity)) return;
	process.kill(identity.pid, "SIGTERM");
	if (await waitForProcessExit(identity)) return;
	if (isProcessIdentityAlive(identity)) process.kill(identity.pid, "SIGKILL");
	if (!(await waitForProcessExit(identity, 1_000))) {
		throw new Error(`Supervisor process ${JSON.stringify(identity)} did not exit`);
	}
}

const runtime = process.env.PI_HEADLESS_RUNTIME ?? "node";
if (runtime !== "node" && runtime !== "bun") {
	throw new Error(`Invalid PI_HEADLESS_RUNTIME ${JSON.stringify(runtime)}: expected node or bun`);
}

function createRuntimeFixture() {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-runtime-"));
	const agentDir = join(tempDir, "agent");
	const stateDir = join(tempDir, "state");
	const kbDir = join(tempDir, "kb");
	const homeDir = join(tempDir, "home");
	const reportPath = join(tempDir, "processes.jsonl");
	const logPath = join(tempDir, "resident.log");
	for (const dir of [agentDir, stateDir, kbDir, homeDir]) mkdirSync(dir, { recursive: true });
	writeOfflineProviderConfig(agentDir);
	const controlDbPath = getControlDbPath(stateDir);
	const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
	return { tempDir, agentDir, stateDir, kbDir, homeDir, reportPath, logPath, controlDbPath, cliPath };
}

type RuntimeFixture = ReturnType<typeof createRuntimeFixture>;
type StartedReport = Extract<ProcessReport, { type: "started" }>;

function writeOfflineProviderConfig(agentDir: string): void {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"openai-codex": {
					api: "openai-codex-responses",
					baseUrl: "https://supervisor-test.invalid",
					models: [{ id: "gpt-6.1-sol", reasoning: true }],
				},
			},
		}),
	);
	AuthStorage.create(join(agentDir, "auth.json")).set("openai-codex", {
		type: "api_key",
		key: "inert-supervisor-startup-test-not-a-credential",
	});
}

function createLaunchInvocation(fixture: RuntimeFixture): SupervisorLaunchInvocation {
	const { cliPath, kbDir } = fixture;
	const preloadPath = join(import.meta.dirname, "fixtures", "supervisor-offline-preload.mjs");
	return {
		command: runtime === "node" ? process.execPath : "bun",
		args: [
			...(runtime === "bun"
				? ["--preload", preloadPath]
				: ["--experimental-strip-types", "--import", pathToFileURL(preloadPath).href]),
			cliPath,
			"supervisor",
		],
		cwd: kbDir,
		env: readIsolatedLaunchEnvironment(fixture),
	};
}

function readIsolatedLaunchEnvironment(fixture: RuntimeFixture): NodeJS.ProcessEnv {
	const { homeDir, stateDir, agentDir, kbDir, reportPath, logPath } = fixture;
	// Allowlist runtime essentials; never inherit provider credentials, user config, or preloads.
	return {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		HOME: homeDir,
		XDG_CONFIG_HOME: join(homeDir, "config"),
		XDG_CACHE_HOME: join(homeDir, "cache"),
		XDG_STATE_HOME: stateDir,
		[ENV_AGENT_DIR]: agentDir,
		[ENV_STATE_DIR]: stateDir,
		PI_KB_DIR: kbDir,
		PI_SKIP_VERSION_CHECK: "1",
		PI_SUPERVISOR_AUTOSTARTED: "1",
		PI_SUPERVISOR_TEST_REPORT: reportPath,
		PI_SUPERVISOR_TEST_LOG: logPath,
	};
}

async function startConcurrentCallers(controlDbPath: string, launchInvocation: SupervisorLaunchInvocation) {
	// Settle both callers before cleanup, including when startup fails.
	const results = await Promise.allSettled([
		ensureSupervisorRunning({ controlDbPath, launchInvocation, startupTimeoutMs: 10_000 }),
		ensureSupervisorRunning({ controlDbPath, launchInvocation, startupTimeoutMs: 10_000 }),
	]);
	return results.map((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
}

function readAndAssertResidentStart(fixture: RuntimeFixture, first: ResidentConsoleIdentity): StartedReport[] {
	const starts = readReports(fixture.reportPath).filter((report) => report.type === "started");
	expect(starts).toHaveLength(1);
	const [started] = starts;
	expect(started.bun).toEqual(runtime === "bun" ? expect.any(String) : null);
	expect(readProcessIdentity(started.identity.pid)).toEqual(started.identity);
	expect(isProcessIdentityAlive(started.identity)).toBe(true);
	expect(first).toEqual({
		version: VERSION,
		pid: started.identity.pid,
		executable: started.executable,
		entrypoint: fixture.cliPath,
		instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		managedBy: "pi",
		ready: true,
	});
	return starts;
}

async function assertResidentReuseAndConsole(
	fixture: RuntimeFixture,
	launchInvocation: SupervisorLaunchInvocation,
	first: ResidentConsoleIdentity,
	second: ResidentConsoleIdentity,
	started: StartedReport,
): Promise<void> {
	const { controlDbPath, kbDir } = fixture;
	expect(second).toEqual(first);
	await expect(ensureSupervisorRunning({ controlDbPath, launchInvocation })).resolves.toEqual(first);
	const snapshot = await probeResidentConsole({
		socketPath: `${controlDbPath}.supervisor-console.sock`,
		service: "supervisor",
	});
	expect(snapshot).toMatchObject({ service: "supervisor", cwd: kbDir, identity: first });
	expect(readProcessIdentity(first.pid)).toEqual(started.identity);
}

async function terminateAndAssertFinalReports(fixture: RuntimeFixture, starts: StartedReport[]): Promise<void> {
	const [started] = starts;
	await terminateSupervisorProcess(started.identity);
	expect(isProcessIdentityAlive(started.identity)).toBe(false);
	const finalReports = readReports(fixture.reportPath);
	expect(finalReports.filter((report) => report.type === "started")).toEqual(starts);
	expect(finalReports.filter((report) => report.type === "request")).toEqual([]);
	expect(finalReports.filter((report) => report.type === "exit")).toEqual([
		{ type: "exit", identity: started.identity, code: 0, requests: 0 },
	]);
	await expect(
		probeResidentConsole({ socketPath: `${fixture.controlDbPath}.supervisor-console.sock`, service: "supervisor" }),
	).rejects.toThrow("Resident console is unavailable");
}

async function cleanupRecordedResidents(fixture: RuntimeFixture, succeeded: boolean): Promise<void> {
	const { reportPath, tempDir, logPath } = fixture;
	// Preload records the native creation identity before CLI initialization, even if readiness fails.
	const cleanup = await Promise.allSettled(
		readReports(reportPath)
			.filter((report) => report.type === "started")
			.map((report) => terminateSupervisorProcess(report.identity)),
	);
	const errors = cleanup.filter((result) => result.status === "rejected");
	if (!succeeded || errors.length > 0) {
		console.error(`Supervisor startup artifacts retained at ${tempDir}`);
		console.error(existsSync(logPath) ? readFileSync(logPath, "utf8") : "Preload did not initialize");
	} else rmSync(tempDir, { force: true, recursive: true });
	if (errors.length > 0) {
		throw new AggregateError(
			errors.map((result) => result.reason),
			"Supervisor cleanup failed",
		);
	}
}

describe("Supervisor automatic startup runtime", () => {
	it(`starts one real ${runtime} resident offline and reuses it across concurrent callers`, async () => {
		expect(process.versions).not.toHaveProperty("bun");
		const fixture = createRuntimeFixture();
		const launchInvocation = createLaunchInvocation(fixture);
		let succeeded = false;
		try {
			const [first, second] = await startConcurrentCallers(fixture.controlDbPath, launchInvocation);
			const starts = readAndAssertResidentStart(fixture, first);
			await assertResidentReuseAndConsole(fixture, launchInvocation, first, second, starts[0]);
			await terminateAndAssertFinalReports(fixture, starts);
			console.log(`${runtime}: 1 real resident started, reused, exited; 0 fetch/WebSocket requests`);
			succeeded = true;
		} finally {
			await cleanupRecordedResidents(fixture, succeeded);
		}
	});
});
