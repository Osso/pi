import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../../../src/config.ts";
import {
	claimDetachedJobRuntimeCommands,
	enqueueDetachedJobStatusResponse,
	type DetachedJobCancelCommand,
	type DetachedJobResponseCommand,
} from "../../../src/core/detached-job-control.ts";
import {
	createDetachedJobTerminalInput,
	type DetachedJobArtifacts,
	type DetachedJobOwnershipIdentity,
	type DetachedJobOutcome,
} from "../../../src/core/detached-job-runner.ts";
import {
	finalizeDetachedJob,
	type RuntimeMailboxAddress,
} from "../../../src/core/session-control-db.ts";
import { finalizeDetachedJobWithRetry } from "../../../src/core/detached-bash-runner.ts";
import { enqueueDetachedPyrunBridgeRequest } from "./detached-bridge.ts";
import {
	type CanonicalPyrunEvalParams,
	type CanonicalPyrunEvalResult,
	type CanonicalPyrunProgressUpdate,
	PyrunRunnerClient,
	type PyrunRunnerOptions,
} from "./runner.ts";

export const DETACHED_PYRUN_RUNNER_MODE = "--internal-detached-pyrun-runner";
const DETACHED_PYRUN_LAUNCH_VERSION = 1;
const CONTROL_POLL_MS = 25;
const LAUNCH_MANIFEST_POLL_MS = 10;
const LAUNCH_MANIFEST_TIMEOUT_MS = 30_000;

export interface DetachedPyrunLaunchManifestData {
	activationPath: string;
	artifacts: DetachedJobArtifacts;
	bridgeRequestPath: string;
	bridgeResponsePath: string;
	controlDbPath: string;
	foregroundCompletionPath: string;
	params: CanonicalPyrunEvalParams;
	runnerAddress: RuntimeMailboxAddress;
	runnerOptions: PyrunRunnerOptions;
	sessionPath: string;
}

interface DetachedPyrunLaunchManifest extends DetachedPyrunLaunchManifestData {
	checksum: string;
	version: typeof DETACHED_PYRUN_LAUNCH_VERSION;
}

export function writeDetachedPyrunLaunchManifest(path: string, data: DetachedPyrunLaunchManifestData): void {
	const unsigned: Omit<DetachedPyrunLaunchManifest, "checksum"> = {
		...data,
		version: DETACHED_PYRUN_LAUNCH_VERSION,
	};
	const manifest = { ...unsigned, checksum: hashJson(unsigned) };
	const temporaryPath = `${path}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: 0o600 });
	fsyncFile(temporaryPath);
	renameSync(temporaryPath, path);
	fsyncDirectory(dirname(path));
}

interface DetachedPyrunControlState {
	cancel?: DetachedJobCancelCommand;
	identity?: DetachedJobOwnershipIdentity;
}

export function writeDetachedPyrunActivation(path: string, identity: DetachedJobOwnershipIdentity): void {
	const temporaryPath = `${path}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(identity)}\n`, { encoding: "utf8", mode: 0o600 });
	fsyncFile(temporaryPath);
	renameSync(temporaryPath, path);
	fsyncDirectory(dirname(path));
}

interface PendingBridgeRequest {
	reject: (error: Error) => void;
	resolve: (result: unknown) => void;
}

type PyrunSettlement =
	| { cancel?: DetachedJobCancelCommand; identity?: DetachedJobOwnershipIdentity; result: CanonicalPyrunEvalResult }
	| { cancel?: DetachedJobCancelCommand; error: unknown; identity?: DetachedJobOwnershipIdentity };

export function getDetachedPyrunRunnerInvocation(
	manifestPath: string,
	options?: { compiled?: boolean; entryPath?: string; executablePath?: string },
): { args: string[]; executable: string } {
	const executable = options?.executablePath ?? process.execPath;
	if (options?.compiled && !options.entryPath) {
		return { args: [DETACHED_PYRUN_RUNNER_MODE, manifestPath], executable };
	}
	const entryPath = options?.entryPath ?? defaultRunnerEntryPath();
	const args = extname(entryPath) === ".ts" ? ["--experimental-strip-types", entryPath, manifestPath] : [entryPath, manifestPath];
	return { args, executable };
}

export function launchDetachedPyrunRunner(manifestPath: string, options?: { entryPath?: string }): number {
	const invocation = getDetachedPyrunRunnerInvocation(manifestPath, {
		compiled: isBunBinary,
		entryPath: options?.entryPath,
	});
	const child = spawn(invocation.executable, invocation.args, {
		cwd: dirname(manifestPath),
		detached: true,
		env: { HOME: process.env.HOME, PATH: process.env.PATH },
		stdio: "ignore",
	});
	if (!child.pid) throw new Error("Could not launch detached Pyrun runner");
	child.once("error", () => undefined);
	child.unref();
	return child.pid;
}

export async function runDetachedPyrunRunner(manifestPath: string): Promise<{ terminalRevision?: number }> {
	const manifest = await waitForDetachedPyrunLaunchManifest(manifestPath);
	const runner = new PyrunRunnerClient(manifest.runnerOptions);
	try {
		const settlement = await waitForDetachedPyrunSettlement(manifest, runner);
		appendPyrunSettlementRecord(manifest, settlement);
		const identity = settlement.identity ?? (await waitForPyrunOwnershipDecision(manifest));
		if (!identity) return {};
		return finalizeDetachedPyrunSettlement(manifest, { ...settlement, identity });
	} finally {
		runner.dispose();
	}
}

async function waitForDetachedPyrunSettlement(
	manifest: DetachedPyrunLaunchManifest,
	runner: PyrunRunnerClient,
): Promise<PyrunSettlement> {
	const abort = new AbortController();
	const control: DetachedPyrunControlState = {};
	const pendingRequests = new Map<string, PendingBridgeRequest>();
	const dispatchPiRequest = (request: { method: string; params: unknown }) =>
		control.identity
			? dispatchDetachedPyrunBridgeRequest(manifest, control.identity, pendingRequests, request)
			: dispatchForegroundPyrunBridgeRequest(manifest, pendingRequests, request);
	const settled = runner
		.evaluate(
			manifest.params,
			(update) => appendArtifactRecord(manifest.artifacts.outputPath, { kind: "progress", update }),
			abort.signal,
			dispatchPiRequest,
		)
		.then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);
	for (;;) {
		const result = await Promise.race([
			settled,
			new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), CONTROL_POLL_MS)),
		]);
		control.identity ??= readDetachedPyrunActivation(manifest.activationPath);
		if (result) return { ...result, cancel: control.cancel, identity: control.identity } as PyrunSettlement;
		if (control.identity) applyDetachedPyrunRuntimeCommands(manifest, control, pendingRequests, abort);
	}
}

function applyDetachedPyrunRuntimeCommands(
	manifest: DetachedPyrunLaunchManifest,
	control: DetachedPyrunControlState,
	pendingRequests: Map<string, PendingBridgeRequest>,
	abort: AbortController,
): void {
	const identity = control.identity;
	if (!identity) return;
	const commands = claimDetachedJobRuntimeCommands(manifest.controlDbPath, manifest.runnerAddress, identity);
	for (const command of commands) {
		if (command.command === "respond") {
			settleBridgeResponse(pendingRequests, command);
			continue;
		}
		if (command.command === "status") {
			enqueueDetachedJobStatusResponse({
				controlDbPath: manifest.controlDbPath,
				identity,
				replyTo: command.replyTo,
				requestId: command.requestId,
				runnerAddress: manifest.runnerAddress,
				sessionPath: manifest.sessionPath,
				status: {
					outputPath: manifest.artifacts.outputPath,
					pendingRequestCount: pendingRequests.size,
					state: "running",
				},
			});
			continue;
		}
		if (!control.cancel) {
			control.cancel = command;
			control.identity = command.identity;
			abort.abort();
		}
	}
}

async function dispatchForegroundPyrunBridgeRequest(
	manifest: DetachedPyrunLaunchManifest,
	pendingRequests: Map<string, PendingBridgeRequest>,
	request: { method: string; params: unknown },
): Promise<unknown> {
	const requestId = randomUUID();
	appendArtifactRecord(manifest.bridgeRequestPath, { ...request, requestId });
	let offset = 0;
	for (;;) {
		const records = readJsonLines<{ claimed?: boolean; error?: string; requestId: string; result?: unknown }>(
			manifest.bridgeResponsePath,
			offset,
		);
		offset = records.offset;
		for (const response of records.values.filter((record) => record.requestId === requestId)) {
			if (response.claimed) continue;
			if (response.error) throw new Error(response.error);
			return response.result;
		}
		const identity = readDetachedPyrunActivation(manifest.activationPath);
		if (identity && claimForegroundBridgeRequest(manifest.artifacts.directory, requestId)) {
			return dispatchDetachedPyrunBridgeRequest(manifest, identity, pendingRequests, request);
		}
		await new Promise((resolve) => setTimeout(resolve, CONTROL_POLL_MS));
	}
}

function claimForegroundBridgeRequest(directory: string, requestId: string): boolean {
	try {
		closeSync(openSync(join(directory, `bridge-claim-${requestId}`), "wx", 0o600));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

function dispatchDetachedPyrunBridgeRequest(
	manifest: DetachedPyrunLaunchManifest,
	identity: DetachedJobOwnershipIdentity,
	pendingRequests: Map<string, PendingBridgeRequest>,
	request: { method: string; params: unknown },
): Promise<unknown> {
	const requestId = enqueueDetachedPyrunBridgeRequest({
		controlDbPath: manifest.controlDbPath,
		identity,
		method: request.method,
		params: request.params,
		runnerAddress: manifest.runnerAddress,
		sessionPath: manifest.sessionPath,
		supervisorAddress: { agentId: null, sessionId: manifest.runnerAddress.sessionId },
	});
	return new Promise((resolve, reject) => pendingRequests.set(requestId, { reject, resolve }));
}

function settleBridgeResponse(
	pendingRequests: Map<string, PendingBridgeRequest>,
	response: DetachedJobResponseCommand,
): void {
	const pending = pendingRequests.get(response.requestId);
	if (!pending) return;
	pendingRequests.delete(response.requestId);
	if (response.error) pending.reject(new Error(response.error));
	else pending.resolve(response.result);
}

function appendPyrunSettlementRecord(manifest: DetachedPyrunLaunchManifest, settlement: PyrunSettlement): void {
	const record = "result" in settlement
		? { kind: "result", result: settlement.result }
		: { error: errorMessage(settlement.error), kind: "error" };
	appendArtifactRecord(manifest.artifacts.outputPath, record);
}

async function finalizeDetachedPyrunSettlement(
	manifest: DetachedPyrunLaunchManifest,
	settlement: PyrunSettlement & { identity: DetachedJobOwnershipIdentity },
): Promise<{ terminalRevision: number }> {
	const outcome = pyrunSettlementOutcome(settlement);
	const terminal = createDetachedJobTerminalInput(
		manifest.artifacts,
		settlement.identity,
		outcome,
		new Date().toISOString(),
	);
	const finalized = await finalizeDetachedJobWithRetry(terminal, (terminalInput) =>
		finalizeDetachedJob(manifest.controlDbPath, { sessionPath: manifest.sessionPath, terminal: terminalInput }),
	);
	if (!finalized.ok) throw new Error(`Could not finalize detached Pyrun job: ${finalized.error}`);
	return { terminalRevision: finalized.terminalRevision };
}

function pyrunSettlementOutcome(settlement: PyrunSettlement): DetachedJobOutcome {
	if ("result" in settlement) return pyrunOutcome(settlement.result);
	if (settlement.cancel) return { kind: "aborted", reason: settlement.cancel.reason ?? "cancelled" };
	return { error: { message: errorMessage(settlement.error) }, kind: "failed" };
}

function defaultRunnerEntryPath(): string {
	const sourceExtension = extname(fileURLToPath(import.meta.url));
	return fileURLToPath(new URL(`./detached-runner-entry${sourceExtension}`, import.meta.url));
}

async function waitForDetachedPyrunLaunchManifest(path: string): Promise<DetachedPyrunLaunchManifest> {
	const deadline = Date.now() + LAUNCH_MANIFEST_TIMEOUT_MS;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for detached Pyrun launch manifest: ${path}`);
		await new Promise((resolve) => setTimeout(resolve, LAUNCH_MANIFEST_POLL_MS));
	}
	return readDetachedPyrunLaunchManifest(path);
}

async function waitForPyrunOwnershipDecision(
	manifest: DetachedPyrunLaunchManifest,
): Promise<DetachedJobOwnershipIdentity | undefined> {
	for (;;) {
		const identity = readDetachedPyrunActivation(manifest.activationPath);
		if (identity) return identity;
		if (existsSync(manifest.foregroundCompletionPath)) return undefined;
		await new Promise((resolve) => setTimeout(resolve, CONTROL_POLL_MS));
	}
}

function readJsonLines<T>(path: string, offset: number): { offset: number; values: T[] } {
	if (!existsSync(path)) return { offset, values: [] };
	const data = readFileSync(path);
	if (data.length <= offset) return { offset, values: [] };
	const values = data
		.subarray(offset)
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as T);
	return { offset: data.length, values };
}

function readDetachedPyrunActivation(path: string): DetachedJobOwnershipIdentity | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8")) as DetachedJobOwnershipIdentity;
}

function readDetachedPyrunLaunchManifest(path: string): DetachedPyrunLaunchManifest {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as DetachedPyrunLaunchManifest;
	const { checksum, ...unsigned } = parsed;
	if (parsed.version !== DETACHED_PYRUN_LAUNCH_VERSION || checksum !== hashJson(unsigned)) {
		throw new Error(`Invalid detached Pyrun launch manifest: ${path}`);
	}
	return parsed;
}

function appendArtifactRecord(path: string, record: unknown): void {
	writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
}

function pyrunOutcome(result: CanonicalPyrunEvalResult) {
	if (result.type === "error") {
		return { error: { message: result.error ?? "Pyrun evaluation failed" }, kind: "failed" } as const;
	}
	return { kind: "completed", summary: "Pyrun evaluation completed." } as const;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
