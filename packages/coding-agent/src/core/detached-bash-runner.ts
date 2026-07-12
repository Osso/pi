import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GatedDetachedPayloadExit, spawnGatedDetachedPayload } from "./detached-job-bootstrap.ts";
import { claimDetachedJobRuntimeCommands, enqueueDetachedJobStatusResponse } from "./detached-job-control.ts";
import {
	type DetachedJobArtifacts,
	type DetachedJobOutcome,
	type DetachedJobOwnershipIdentity,
	writeDetachedJobTerminalEnvelope,
} from "./detached-job-runner.ts";
import { finalizeDetachedJob, type RuntimeMailboxAddress } from "./session-control-db.ts";

const DETACHED_BASH_LAUNCH_VERSION = 1;
const LAUNCH_MANIFEST_POLL_MS = 10;
const LAUNCH_MANIFEST_TIMEOUT_MS = 30_000;

export interface DetachedBashLaunchManifestData {
	args: string[];
	artifacts: DetachedJobArtifacts;
	command: string;
	controlDbPath: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	identity: DetachedJobOwnershipIdentity;
	runnerAddress: RuntimeMailboxAddress;
	sessionPath: string;
	timeoutMs?: number;
}

interface DetachedBashLaunchManifest extends DetachedBashLaunchManifestData {
	checksum: string;
	version: typeof DETACHED_BASH_LAUNCH_VERSION;
}

export interface DetachedBashRunnerResult {
	exitCode: number | null;
	terminalRevision: number;
}

export function writeDetachedBashLaunchManifest(path: string, data: DetachedBashLaunchManifestData): void {
	const unsigned: Omit<DetachedBashLaunchManifest, "checksum"> = {
		...data,
		version: DETACHED_BASH_LAUNCH_VERSION,
	};
	const manifest: DetachedBashLaunchManifest = { ...unsigned, checksum: hashJson(unsigned) };
	const temporaryPath = `${path}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
	fsyncFile(temporaryPath);
	renameSync(temporaryPath, path);
	fsyncDirectory(dirname(path));
}

export function launchDetachedBashRunner(manifestPath: string, options?: { entryPath?: string }): number {
	const entryPath = options?.entryPath ?? defaultRunnerEntryPath();
	const nodeArgs =
		extname(entryPath) === ".ts"
			? ["--experimental-strip-types", entryPath, manifestPath]
			: [entryPath, manifestPath];
	const child = spawn(process.execPath, nodeArgs, {
		cwd: dirname(manifestPath),
		detached: true,
		env: { HOME: process.env.HOME, PATH: process.env.PATH },
		stdio: "ignore",
	});
	if (!child.pid) throw new Error("Could not launch detached Bash runner");
	child.once("error", () => undefined);
	child.unref();
	return child.pid;
}

export async function runDetachedBashRunner(
	manifestPath: string,
	options?: { now?: () => string },
): Promise<DetachedBashRunnerResult> {
	const manifest = await waitForDetachedBashLaunchManifest(manifestPath);
	const payload = spawnGatedDetachedPayload({
		args: manifest.args,
		command: manifest.command,
		cwd: manifest.cwd,
		env: manifest.env,
		identityPath: join(manifest.artifacts.directory, "payload.json"),
		stderrPath: manifest.artifacts.outputPath,
		stdoutPath: manifest.artifacts.outputPath,
	});
	payload.persistIdentity();
	payload.release();
	const controlled = await waitForDetachedBashExit(payload, manifest);
	const outcome = controlled.timedOut
		? ({ error: { message: "Detached Bash command timed out" }, kind: "failed" } as const)
		: controlled.cancelReason
			? ({ kind: "aborted", reason: controlled.cancelReason } as const)
			: detachedBashOutcome(controlled.exit.exitCode, controlled.exit.signal);
	const terminalAt = options?.now?.() ?? new Date().toISOString();
	writeDetachedJobTerminalEnvelope(manifest.artifacts, controlled.identity, outcome, terminalAt);
	const finalized = await finalizeDetachedEnvelopeWithRetry(manifest.artifacts.terminalEnvelopePath, (envelopePath) =>
		finalizeDetachedJob(manifest.controlDbPath, { envelopePath, sessionPath: manifest.sessionPath }),
	);
	if (!finalized.ok) throw new Error(`Could not finalize detached Bash job: ${finalized.error}`);
	return { exitCode: controlled.exit.exitCode, terminalRevision: finalized.terminalRevision };
}

async function waitForDetachedBashExit(
	payload: ReturnType<typeof spawnGatedDetachedPayload>,
	manifest: DetachedBashLaunchManifest,
): Promise<{
	cancelReason?: string;
	exit: GatedDetachedPayloadExit;
	identity: DetachedJobOwnershipIdentity;
	timedOut: boolean;
}> {
	let exit: GatedDetachedPayloadExit | undefined;
	let cancelReason: string | undefined;
	let identity = manifest.identity;
	let timedOut = false;
	const timeoutAt = manifest.timeoutMs === undefined ? undefined : Date.now() + manifest.timeoutMs;
	const exitPromise = payload.waitForExit().then((result) => {
		exit = result;
	});
	while (!exit) {
		if (!timedOut && timeoutAt !== undefined && Date.now() >= timeoutAt) {
			timedOut = true;
			signalPayloadGroup(payload.pid);
		}
		for (const command of claimDetachedJobRuntimeCommands(manifest.controlDbPath, manifest.runnerAddress, identity)) {
			if (command.command === "status") {
				enqueueDetachedJobStatusResponse({
					controlDbPath: manifest.controlDbPath,
					identity,
					replyTo: command.replyTo,
					requestId: command.requestId,
					runnerAddress: manifest.runnerAddress,
					sessionPath: manifest.sessionPath,
					status: { outputPath: manifest.artifacts.outputPath, payloadPid: payload.pid, state: "running" },
				});
				continue;
			}
			if (command.command !== "cancel") continue;
			identity = command.identity;
			cancelReason = command.reason ?? "cancelled";
			signalPayloadGroup(payload.pid);
		}
		await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 25))]);
	}
	return { cancelReason, exit, identity, timedOut };
}

function signalPayloadGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
	}
}

export async function finalizeDetachedEnvelopeWithRetry<T>(
	envelopePath: string,
	finalize: (envelopePath: string) => T,
	options?: { retryDelayMs?: number; sleep?: (milliseconds: number) => Promise<void> },
): Promise<T> {
	const retryDelayMs = options?.retryDelayMs ?? 250;
	const sleep =
		options?.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
	for (;;) {
		try {
			return finalize(envelopePath);
		} catch {
			await sleep(retryDelayMs);
		}
	}
}

function defaultRunnerEntryPath(): string {
	const sourceExtension = extname(fileURLToPath(import.meta.url));
	return fileURLToPath(new URL(`./detached-bash-runner-entry${sourceExtension}`, import.meta.url));
}

async function waitForDetachedBashLaunchManifest(path: string): Promise<DetachedBashLaunchManifest> {
	const deadline = Date.now() + LAUNCH_MANIFEST_TIMEOUT_MS;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for detached Bash launch manifest: ${path}`);
		await new Promise((resolve) => setTimeout(resolve, LAUNCH_MANIFEST_POLL_MS));
	}
	return readDetachedBashLaunchManifest(path);
}

function readDetachedBashLaunchManifest(path: string): DetachedBashLaunchManifest {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as DetachedBashLaunchManifest;
	const { checksum, ...unsigned } = parsed;
	if (parsed.version !== DETACHED_BASH_LAUNCH_VERSION || checksum !== hashJson(unsigned)) {
		throw new Error(`Invalid detached Bash launch manifest: ${path}`);
	}
	return parsed;
}

function detachedBashOutcome(exitCode: number | null, signal: NodeJS.Signals | null): DetachedJobOutcome {
	if (exitCode === 0) return { exitCode, kind: "completed", summary: "Process exited successfully." };
	const detail = signal ? `signal ${signal}` : `exit code ${exitCode ?? "null"}`;
	return { error: { message: `Process exited with ${detail}.` }, exitCode: exitCode ?? undefined, kind: "failed" };
}

function hashJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fsyncFile(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function fsyncDirectory(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
