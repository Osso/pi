import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readDetachedPyrunLaunchManifest } from "../../extensions/pyrun/src/detached-runner.ts";
import { isProcessIdentityAlive, type ProcessIdentity } from "../../src/core/runtime-process.ts";

const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const PROCESS_EXIT_POLL_INTERVAL_MS = 10;

function readPyrunRunnerIdentity(path: string): ProcessIdentity | undefined {
	try {
		return readDetachedPyrunLaunchManifest(path).runnerProcessIdentity;
	} catch {
		return undefined;
	}
}

function collectPyrunRunnerIdentities(roots: readonly string[]): ProcessIdentity[] {
	const identities = new Map<string, ProcessIdentity>();
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const relativePath of readdirSync(root, { recursive: true })) {
			if (typeof relativePath !== "string" || !relativePath.endsWith("launch.json")) continue;
			const identity = readPyrunRunnerIdentity(join(root, relativePath));
			if (identity) identities.set(`${identity.pid}:${identity.startTimeTicks}`, identity);
		}
	}
	return [...identities.values()];
}

function terminatePyrunRunnerProcessGroup(identity: ProcessIdentity): void {
	if (!isProcessIdentityAlive(identity)) return;
	try {
		process.kill(-identity.pid, "SIGKILL");
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	try {
		process.kill(identity.pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

async function waitForPyrunRunnersToExit(identities: readonly ProcessIdentity[]): Promise<void> {
	const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
	while (identities.some((identity) => isProcessIdentityAlive(identity))) {
		if (Date.now() >= deadline) {
			const active = identities.filter((identity) => isProcessIdentityAlive(identity));
			throw new Error(
				`Timed out waiting for test Pyrun runners: ${active.map((identity) => identity.pid).join(", ")}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_INTERVAL_MS));
	}
}

export async function terminateDetachedPyrunTestProcesses(roots: readonly string[]): Promise<void> {
	const identities = collectPyrunRunnerIdentities(roots);
	for (const identity of identities) terminatePyrunRunnerProcessGroup(identity);
	await waitForPyrunRunnersToExit(identities);
}
