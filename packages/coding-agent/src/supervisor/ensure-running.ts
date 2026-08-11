import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { isBunBinary, VERSION } from "../config.ts";
import { probeResidentConsole, type ResidentConsoleIdentity } from "../core/resident-console-transport.ts";
import { isVerifiedPiRuntimeProcess } from "../core/runtime-process.ts";
import { spawnProcess } from "../utils/child-process.ts";

export const SUPERVISOR_AUTOSTART_ENV = "PI_SUPERVISOR_AUTOSTARTED";

const SUPERVISOR_START_LOCK_STALE_MS = 5_000;
const SUPERVISOR_START_LOCK_UPDATE_MS = 1_000;
const supervisorStartups = new Map<string, Promise<ResidentConsoleIdentity>>();

export interface SupervisorLaunchInvocation {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface SupervisorLaunchRuntime {
	argv: readonly string[];
	execArgv: readonly string[];
	execPath: string;
	homeDir: string;
	isCompiledBinary: boolean;
	env: NodeJS.ProcessEnv;
}

export interface EnsureSupervisorRunningInput {
	controlDbPath: string;
	launchInvocation?: SupervisorLaunchInvocation;
	pollIntervalMs?: number;
	startupTimeoutMs?: number;
}

export interface EnsureSupervisorRunningDependencies {
	launch?: (invocation: SupervisorLaunchInvocation) => Promise<void>;
	probe?: (controlDbPath: string) => Promise<ResidentConsoleIdentity | undefined>;
	terminate?: (identity: ResidentConsoleIdentity) => Promise<void>;
}

export function getSupervisorStartLockPath(controlDbPath: string): string {
	return `${controlDbPath}.supervisor-start.lock`;
}

export function resolveSupervisorLaunchInvocation(runtime: SupervisorLaunchRuntime): SupervisorLaunchInvocation {
	const env = { ...runtime.env, [SUPERVISOR_AUTOSTART_ENV]: "1" };
	if (runtime.isCompiledBinary) {
		return { command: runtime.execPath, args: ["supervisor"], cwd: runtime.homeDir, env };
	}
	const entrypoint = runtime.argv[1];
	if (!entrypoint) throw new Error("Cannot start Supervisor without the active Pi CLI entrypoint");
	return {
		command: runtime.execPath,
		args: [...runtime.execArgv, entrypoint, "supervisor"],
		cwd: runtime.homeDir,
		env,
	};
}

export async function ensureSupervisorRunning(
	input: EnsureSupervisorRunningInput,
	dependencies: EnsureSupervisorRunningDependencies = {},
): Promise<ResidentConsoleIdentity> {
	const probe = dependencies.probe ?? probeSupervisorIdentity;
	const resident = await probe(input.controlDbPath);
	if (resident?.version === VERSION) return resident;
	return coordinateSupervisorStartup(input, dependencies, probe);
}

function coordinateSupervisorStartup(
	input: EnsureSupervisorRunningInput,
	dependencies: EnsureSupervisorRunningDependencies,
	probe: NonNullable<EnsureSupervisorRunningDependencies["probe"]>,
): Promise<ResidentConsoleIdentity> {
	const startupKey = resolve(input.controlDbPath);
	const existingStartup = supervisorStartups.get(startupKey);
	if (existingStartup) return existingStartup;
	const startup = withSupervisorStartLock(input.controlDbPath, () =>
		ensureSupervisorUnderLock(input, dependencies, probe),
	).finally(() => {
		if (supervisorStartups.get(startupKey) === startup) supervisorStartups.delete(startupKey);
	});
	supervisorStartups.set(startupKey, startup);
	return startup;
}

async function probeSupervisorIdentity(controlDbPath: string): Promise<ResidentConsoleIdentity | undefined> {
	try {
		const snapshot = await probeResidentConsole<unknown>({
			socketPath: `${controlDbPath}.supervisor-console.sock`,
			service: "supervisor",
		});
		if (!snapshot.identity) {
			throw new Error("Running Supervisor does not expose process identity; restart it before retrying");
		}
		return snapshot.identity;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Resident console is unavailable:")) return undefined;
		throw error;
	}
}

async function ensureSupervisorUnderLock(
	input: EnsureSupervisorRunningInput,
	dependencies: EnsureSupervisorRunningDependencies,
	probe: NonNullable<EnsureSupervisorRunningDependencies["probe"]>,
): Promise<ResidentConsoleIdentity> {
	const resident = await probe(input.controlDbPath);
	if (resident?.version === VERSION) return resident;
	if (resident) await stopIncompatibleSupervisor(input, dependencies, probe, resident);
	const launch = dependencies.launch ?? launchSupervisor;
	await launch(input.launchInvocation ?? resolveCurrentSupervisorLaunchInvocation());
	return waitForSupervisorReadiness(input, probe);
}

async function stopIncompatibleSupervisor(
	input: EnsureSupervisorRunningInput,
	dependencies: EnsureSupervisorRunningDependencies,
	probe: NonNullable<EnsureSupervisorRunningDependencies["probe"]>,
	resident: ResidentConsoleIdentity,
): Promise<void> {
	if (resident.managedBy === "external") {
		throw new Error(
			`The externally managed Supervisor version ${resident.version} does not match Pi version ${VERSION}; restart its service manager`,
		);
	}
	const terminate = dependencies.terminate ?? terminateSupervisor;
	await terminate(resident);
	await waitForSupervisorExit(input, probe, resident.instanceId);
}

async function withSupervisorStartLock<T>(controlDbPath: string, action: () => Promise<T>): Promise<T> {
	mkdirSync(dirname(controlDbPath), { mode: 0o700, recursive: true });
	const release = await lockfile.lock(controlDbPath, {
		lockfilePath: getSupervisorStartLockPath(controlDbPath),
		realpath: false,
		stale: SUPERVISOR_START_LOCK_STALE_MS,
		update: SUPERVISOR_START_LOCK_UPDATE_MS,
		retries: { retries: 100, factor: 1.1, minTimeout: 25, maxTimeout: 100, randomize: true },
	});
	try {
		return await action();
	} finally {
		await release();
	}
}

async function launchSupervisor(invocation: SupervisorLaunchInvocation): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawnProcess(invocation.command, invocation.args, {
			cwd: invocation.cwd,
			detached: true,
			env: invocation.env,
			stdio: "ignore",
		});
		const onError = (error: Error) => reject(new Error(`Could not start Supervisor: ${error.message}`));
		child.once("error", onError);
		child.once("spawn", () => {
			child.off("error", onError);
			child.once("error", (error) => console.error(`Supervisor process error: ${error.message}`));
			child.unref();
			resolve();
		});
	});
}

async function terminateSupervisor(identity: ResidentConsoleIdentity): Promise<void> {
	if (identity.pid === process.pid || !isVerifiedPiRuntimeProcess(identity.pid)) {
		throw new Error(`Refusing to terminate unverified Supervisor process ${identity.pid}`);
	}
	try {
		process.kill(identity.pid, "SIGTERM");
	} catch (error) {
		throw new Error(
			`Could not terminate Supervisor process ${identity.pid}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function resolveCurrentSupervisorLaunchInvocation(): SupervisorLaunchInvocation {
	return resolveSupervisorLaunchInvocation({
		argv: process.argv,
		execArgv: process.execArgv,
		execPath: process.execPath,
		homeDir: homedir(),
		isCompiledBinary: isBunBinary,
		env: process.env,
	});
}

async function waitForSupervisorExit(
	input: EnsureSupervisorRunningInput,
	probe: NonNullable<EnsureSupervisorRunningDependencies["probe"]>,
	instanceId: string,
): Promise<void> {
	const startupTimeoutMs = input.startupTimeoutMs ?? 10_000;
	const pollIntervalMs = input.pollIntervalMs ?? 50;
	const deadline = Date.now() + startupTimeoutMs;
	while (Date.now() < deadline) {
		const resident = await probe(input.controlDbPath);
		if (!resident || resident.instanceId !== instanceId) return;
		await delay(pollIntervalMs);
	}
	throw new Error(`Supervisor instance ${instanceId} did not stop within ${startupTimeoutMs}ms`);
}

async function waitForSupervisorReadiness(
	input: EnsureSupervisorRunningInput,
	probe: NonNullable<EnsureSupervisorRunningDependencies["probe"]>,
): Promise<ResidentConsoleIdentity> {
	const startupTimeoutMs = input.startupTimeoutMs ?? 10_000;
	const pollIntervalMs = input.pollIntervalMs ?? 50;
	const deadline = Date.now() + startupTimeoutMs;
	while (Date.now() < deadline) {
		const resident = await probe(input.controlDbPath);
		if (resident?.version === VERSION) return resident;
		await delay(pollIntervalMs);
	}
	throw new Error(`Supervisor did not become ready within ${startupTimeoutMs}ms`);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
