import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../config.ts";
import { type GatedDetachedPayloadExit, spawnGatedDetachedPayload } from "./detached-job-bootstrap.ts";
import { claimDetachedJobRuntimeCommands, enqueueDetachedJobStatusResponse } from "./detached-job-control.ts";
import {
	createDetachedJobTerminalInput,
	type DetachedJobArtifacts,
	type DetachedJobOutcome,
	type DetachedJobOwnershipIdentity,
	type DetachedJobTerminalInput,
} from "./detached-job-runner.ts";
import { isProcessIdentityAlive, type ProcessIdentity, readProcessIdentity } from "./runtime-process.ts";
import { finalizeDetachedJob, type RuntimeMailboxAddress } from "./session-control-db.ts";
import { isSqliteContentionError } from "./sqlite.ts";

export const DETACHED_BASH_RUNNER_MODE = "--internal-detached-bash-runner";
const DETACHED_BASH_LAUNCH_VERSION = 3;
const LAUNCH_MANIFEST_POLL_MS = 10;
const PAYLOAD_KILL_GRACE_MS = 1_000;
const FOREGROUND_BASH_CANCELLATION_MARKER = "foreground-cancelled";
const LAUNCH_MANIFEST_TIMEOUT_MS = 30_000;

export interface DetachedBashLaunchManifestData {
	activationPath: string;
	args: string[];
	artifacts: DetachedJobArtifacts;
	command: string;
	controlDbPath: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	foregroundCompletionPath: string;
	runnerAddress: RuntimeMailboxAddress;
	sessionPath: string;
	timeoutMs?: number;
	toolCallId?: string;
}

interface DetachedBashLaunchManifest extends DetachedBashLaunchManifestData {
	checksum: string;
	version: typeof DETACHED_BASH_LAUNCH_VERSION;
}

export interface DetachedBashRunnerResult {
	exitCode: number | null;
	terminalRevision: number;
}

export interface DetachedBashForegroundCompletion {
	cancelReason?: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
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

export function writeDetachedBashActivation(path: string, identity: DetachedJobOwnershipIdentity): void {
	writeAtomicJson(path, identity);
}

function bashActivationIntentPath(activationPath: string): string {
	return `${activationPath}.pending`;
}

export function withDetachedBashActivationIntent<T>(activationPath: string, activate: () => T): T {
	const intentPath = bashActivationIntentPath(activationPath);
	try {
		writeAtomicJson(intentPath, readProcessIdentity(process.pid));
		return activate();
	} finally {
		rmSync(intentPath, { force: true });
	}
}

export function requestDetachedBashForegroundCancellation(directory: string): Error | undefined {
	try {
		writeFileSync(join(directory, FOREGROUND_BASH_CANCELLATION_MARKER), "", { mode: 0o600 });
		return undefined;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObjectFile(path: string, label: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Invalid ${label} JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isPlainRecord(parsed)) {
		throw new Error(`Invalid ${label} in ${path}: expected JSON object`);
	}
	return parsed;
}

export function readDetachedBashActivation(path: string): DetachedJobOwnershipIdentity | undefined {
	if (!existsSync(path)) return undefined;
	const parsed = parseJsonObjectFile(path, "detached Bash activation");
	if (
		typeof parsed.jobId !== "string" ||
		!isPlainRecord(parsed.owner) ||
		typeof parsed.owner.sessionId !== "string" ||
		(parsed.owner.agentId !== null && typeof parsed.owner.agentId !== "string") ||
		!isPlainRecord(parsed.processIdentity) ||
		typeof parsed.outputLabel !== "string"
	) {
		throw new Error(`Invalid detached Bash activation: ${path}`);
	}
	return parsed as unknown as DetachedJobOwnershipIdentity;
}

export function getDetachedBashRunnerInvocation(
	manifestPath: string,
	options?: { compiled?: boolean; entryPath?: string; executablePath?: string },
): { args: string[]; executable: string } {
	const executable = options?.executablePath ?? process.execPath;
	if (options?.compiled && !options.entryPath) {
		return { args: [DETACHED_BASH_RUNNER_MODE, manifestPath], executable };
	}
	const entryPath = options?.entryPath ?? defaultRunnerEntryPath();
	const args =
		extname(entryPath) === ".ts"
			? ["--experimental-strip-types", entryPath, manifestPath]
			: [entryPath, manifestPath];
	return { args, executable };
}

export function launchDetachedBashRunner(manifestPath: string, options?: { entryPath?: string }): number {
	const invocation = getDetachedBashRunnerInvocation(manifestPath, {
		compiled: isBunBinary,
		entryPath: options?.entryPath,
	});
	const child = spawn(invocation.executable, invocation.args, {
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
	const cancelPath = join(manifest.artifacts.directory, FOREGROUND_BASH_CANCELLATION_MARKER);
	if (!existsSync(cancelPath)) payload.release();
	const { cancelReason, exit, identity, timedOut } = await waitForDetachedBashExit(payload, manifest, cancelPath);
	const ownership =
		identity ?? (await publishForegroundExitAndWaitForActivation(manifest, { ...exit, cancelReason, timedOut }));
	if (!ownership) return { exitCode: exit.exitCode, terminalRevision: 0 };
	const outcome = timedOut
		? ({ error: { message: "Detached Bash command timed out" }, kind: "failed" } as const)
		: cancelReason
			? ({ kind: "aborted", reason: cancelReason } as const)
			: detachedBashOutcome(exit.exitCode, exit.signal);
	const terminal = createDetachedJobTerminalInput(
		manifest.artifacts,
		ownership,
		outcome,
		options?.now?.() ?? new Date().toISOString(),
		undefined,
		manifest.toolCallId,
	);
	const finalized = await finalizeDetachedJobWithRetry(terminal, (terminalInput) =>
		finalizeDetachedJob(manifest.controlDbPath, { sessionPath: manifest.sessionPath, terminal: terminalInput }),
	);
	if (!finalized.ok) throw new Error(`Could not finalize detached Bash job: ${finalized.error}`);
	return { exitCode: exit.exitCode, terminalRevision: finalized.terminalRevision };
}

async function publishForegroundExitAndWaitForActivation(
	manifest: DetachedBashLaunchManifest,
	completion: DetachedBashForegroundCompletion,
): Promise<DetachedJobOwnershipIdentity | undefined> {
	// A detach that started before this marker may already be registering the job.
	writeAtomicJson(manifest.foregroundCompletionPath, completion);
	const intentPath = bashActivationIntentPath(manifest.activationPath);
	let intentPublisher: ProcessIdentity | undefined;
	try {
		intentPublisher = JSON.parse(readFileSync(intentPath, "utf8")) as ProcessIdentity;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`Could not read Bash detach intent ${intentPath}`, { cause: error });
		}
	}
	while (intentPublisher && existsSync(intentPath) && isProcessIdentityAlive(intentPublisher)) {
		await new Promise((resolve) => setTimeout(resolve, LAUNCH_MANIFEST_POLL_MS));
	}
	// Activation is published before the observer clears its intent.
	return readDetachedBashActivation(manifest.activationPath);
}

async function waitForDetachedBashExit(
	payload: ReturnType<typeof spawnGatedDetachedPayload>,
	manifest: DetachedBashLaunchManifest,
	foregroundCancellationPath: string,
): Promise<{
	cancelReason?: string;
	exit: GatedDetachedPayloadExit;
	identity?: DetachedJobOwnershipIdentity;
	timedOut: boolean;
}> {
	let exit: GatedDetachedPayloadExit | undefined;
	let cancelReason: string | undefined;
	let identity = readDetachedBashActivation(manifest.activationPath);
	let timedOut = false;
	let killAt: number | undefined;
	const timeoutAt = manifest.timeoutMs === undefined ? undefined : Date.now() + manifest.timeoutMs;
	const terminatePayload = () => {
		signalPayloadGroup(payload.pid, "SIGTERM");
		killAt ??= Date.now() + PAYLOAD_KILL_GRACE_MS;
	};
	const exitPromise = payload.waitForExit().then((result) => {
		exit = result;
	});
	for (;;) {
		identity ??= readDetachedBashActivation(manifest.activationPath);
		// The shell can exit on SIGTERM while a child in its group ignores it, so finish the escalation first.
		if (exit && (killAt === undefined || !isPayloadGroupAlive(payload.pid))) {
			return { cancelReason, exit, identity, timedOut };
		}
		cancelReason ??= cancelForegroundBashPayload(payload.pid, foregroundCancellationPath);
		if (!timedOut && timeoutAt !== undefined && Date.now() >= timeoutAt) {
			timedOut = true;
			terminatePayload();
		}
		// A payload that ignores SIGTERM must still stop after a timeout or cancellation.
		if (killAt !== undefined && Date.now() >= killAt) signalPayloadGroup(payload.pid, "SIGKILL");
		if (identity) {
			for (const command of claimDetachedJobRuntimeCommands(
				manifest.controlDbPath,
				manifest.runnerAddress,
				identity,
			)) {
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
				terminatePayload();
			}
		}
		const poll = new Promise((resolve) => setTimeout(resolve, 25));
		await (exit ? poll : Promise.race([exitPromise, poll]));
	}
}

function cancelForegroundBashPayload(pid: number, cancellationPath: string): string | undefined {
	if (!existsSync(cancellationPath)) return undefined;
	signalPayloadGroup(pid, "SIGKILL");
	return "foreground cancellation";
}

function isPayloadGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

function signalPayloadGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
	}
}

export async function finalizeDetachedJobWithRetry<T>(
	terminal: DetachedJobTerminalInput,
	finalize: (terminal: DetachedJobTerminalInput) => T,
	options?: { retryDelayMs?: number; sleep?: (milliseconds: number) => Promise<void> },
): Promise<T> {
	const retryDelayMs = options?.retryDelayMs ?? 250;
	const sleep =
		options?.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
	for (;;) {
		try {
			return finalize(terminal);
		} catch (error) {
			if (!isSqliteContentionError(error)) throw error;
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

export function readDetachedBashLaunchManifest(path: string): DetachedBashLaunchManifest {
	const parsed = parseJsonObjectFile(path, "detached Bash launch manifest");
	const { checksum, ...unsigned } = parsed;
	if (
		parsed.version !== DETACHED_BASH_LAUNCH_VERSION ||
		typeof checksum !== "string" ||
		typeof parsed.activationPath !== "string" ||
		!Array.isArray(parsed.args) ||
		!parsed.args.every((arg): arg is string => typeof arg === "string") ||
		!isPlainRecord(parsed.artifacts) ||
		typeof parsed.artifacts.directory !== "string" ||
		typeof parsed.artifacts.outputPath !== "string" ||
		typeof parsed.command !== "string" ||
		typeof parsed.controlDbPath !== "string" ||
		typeof parsed.cwd !== "string" ||
		!isPlainRecord(parsed.env) ||
		typeof parsed.foregroundCompletionPath !== "string" ||
		!isPlainRecord(parsed.runnerAddress) ||
		typeof parsed.sessionPath !== "string" ||
		checksum !== hashJson(unsigned)
	) {
		throw new Error(`Invalid detached Bash launch manifest: ${path}`);
	}
	return parsed as unknown as DetachedBashLaunchManifest;
}

function detachedBashOutcome(exitCode: number | null, signal: NodeJS.Signals | null): DetachedJobOutcome {
	if (exitCode === 0) return { exitCode, kind: "completed", summary: "Process exited successfully." };
	const detail = signal ? `signal ${signal}` : `exit code ${exitCode ?? "null"}`;
	return { error: { message: `Process exited with ${detail}.` }, exitCode: exitCode ?? undefined, kind: "failed" };
}

function hashJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function writeAtomicJson(path: string, value: unknown): void {
	const temporaryPath = `${path}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	fsyncFile(temporaryPath);
	renameSync(temporaryPath, path);
	fsyncDirectory(dirname(path));
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
