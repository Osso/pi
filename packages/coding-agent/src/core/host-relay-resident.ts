import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { getAgentDir, isBunBinary, VERSION } from "../config.ts";
import { spawnProcess } from "../utils/child-process.ts";
import { type RelaySettings, runSshRelayClient } from "./host-relay-client.ts";
import {
	isProcessIdentityAlive,
	isRuntimeExecutableReplaced,
	isVerifiedPiRuntimeProcess,
	type ProcessIdentity,
	readProcessIdentity,
} from "./runtime-process.ts";
import { getControlDbPath } from "./session-control-db.ts";
import { SettingsManager } from "./settings-manager.ts";

interface RelayIdentity extends ProcessIdentity {
	version: string;
}

export interface RelayLaunchInvocation {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

const LOCK_OPTIONS = { realpath: false, stale: 5000, update: 1000 };

function readRelayIdentity(controlDbPath: string): RelayIdentity | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(`${controlDbPath}.relay.json`, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("pid" in value) ||
		!("startTimeTicks" in value) ||
		!("version" in value) ||
		typeof value.pid !== "number" ||
		typeof value.startTimeTicks !== "number" ||
		typeof value.version !== "string"
	) {
		throw new Error(`Invalid relay identity in ${controlDbPath}.relay.json`);
	}
	const identity = { pid: value.pid, startTimeTicks: value.startTimeTicks, version: value.version };
	return isProcessIdentityAlive(identity) ? identity : undefined;
}

async function waitForRelay(controlDbPath: string, ready: boolean): Promise<void> {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const identity = readRelayIdentity(controlDbPath);
		if (ready ? isCurrentRelay(identity) : !identity) return;
		await delay(50);
	}
	throw new Error(`Relay did not ${ready ? "start" : "stop"} within 10000ms`);
}

/** Builds share one version, so a relay whose executable a deployment replaced is stale too. */
function isCurrentRelay(identity: RelayIdentity | undefined): boolean {
	return identity?.version === VERSION && !isRuntimeExecutableReplaced(identity.pid);
}

/** Call without awaiting at session startup; callers report errors without failing the session. */
export async function ensureRelayRunning(
	controlDbPath: string,
	settings: RelaySettings | undefined,
	launchInvocation?: RelayLaunchInvocation,
): Promise<void> {
	if (!settings) return;
	mkdirSync(dirname(controlDbPath), { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(controlDbPath, {
		...LOCK_OPTIONS,
		lockfilePath: `${controlDbPath}.relay-start.lock`,
		retries: { retries: 100, factor: 1.1, minTimeout: 25, maxTimeout: 100, randomize: true },
	});
	try {
		const resident = readRelayIdentity(controlDbPath);
		if (isCurrentRelay(resident)) return;
		if (resident) {
			if (resident.pid === process.pid || !isVerifiedPiRuntimeProcess(resident.pid)) {
				throw new Error(`Refusing to terminate unverified relay process ${resident.pid}`);
			}
			process.kill(resident.pid, "SIGTERM");
			await waitForRelay(controlDbPath, false);
		}
		await launchRelay(controlDbPath, launchInvocation ?? resolveCurrentRelayLaunchInvocation());
		await waitForRelay(controlDbPath, true);
	} finally {
		await release();
	}
}

function resolveCurrentRelayLaunchInvocation(): RelayLaunchInvocation {
	const entrypoint = process.argv[1];
	if (!isBunBinary && !entrypoint) throw new Error("Cannot start relay without the active Pi CLI entrypoint");
	const args = isBunBinary ? ["relay", "connect"] : [...process.execArgv, entrypoint!, "relay", "connect"];
	return { command: process.execPath, args, env: process.env };
}

async function launchRelay(controlDbPath: string, invocation: RelayLaunchInvocation): Promise<void> {
	const log = openSync(`${controlDbPath}.relay.log`, "a", 0o600);
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawnProcess(invocation.command, invocation.args, {
				cwd: homedir(),
				env: invocation.env,
				detached: true,
				stdio: ["ignore", log, log],
			});
			child.once("error", reject);
			child.once("spawn", () => {
				child.off("error", reject);
				child.once("error", (error) => console.error(`Relay process error: ${error.message}`));
				child.unref();
				resolve();
			});
		});
	} finally {
		closeSync(log);
	}
}

export async function runRelayConnect(): Promise<void> {
	const settings = SettingsManager.create(homedir(), getAgentDir(), { projectTrusted: false }).getGlobalSettings()
		.relay;
	if (!settings) return;
	const controlDbPath = getControlDbPath();
	mkdirSync(dirname(controlDbPath), { recursive: true, mode: 0o700 });
	let release: () => Promise<void>;
	try {
		release = await lockfile.lock(controlDbPath, {
			...LOCK_OPTIONS,
			lockfilePath: `${controlDbPath}.relay.lock`,
			retries: { retries: 60, minTimeout: 100, maxTimeout: 100 },
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED") return;
		throw error;
	}
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		const identityPath = `${controlDbPath}.relay.json`;
		writeFileSync(`${identityPath}.tmp`, JSON.stringify({ ...readProcessIdentity(process.pid), version: VERSION }), {
			mode: 0o600,
		});
		renameSync(`${identityPath}.tmp`, identityPath);
		await runSshRelayClient(controlDbPath, settings, controller.signal);
	} finally {
		controller.abort();
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		try {
			unlinkSync(`${controlDbPath}.relay.json`);
		} finally {
			await release();
		}
	}
}
