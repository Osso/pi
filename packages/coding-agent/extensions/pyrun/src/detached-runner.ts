import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	claimDetachedJobControlCommands,
	type DetachedJobCancelCommand,
} from "../../../src/core/detached-job-control.ts";
import {
	type DetachedJobArtifacts,
	type DetachedJobLeaseIdentity,
	type DetachedJobOutcome,
	writeDetachedJobTerminalEnvelope,
} from "../../../src/core/detached-job-runner.ts";
import {
	finalizeDetachedJob,
	type RuntimeMailboxAddress,
} from "../../../src/core/session-control-db.ts";
import { finalizeDetachedEnvelopeWithRetry } from "../../../src/core/detached-bash-runner.ts";
import {
	type CanonicalPyrunEvalParams,
	type CanonicalPyrunEvalResult,
	type CanonicalPyrunProgressUpdate,
	PyrunRunnerClient,
	type PyrunRunnerOptions,
} from "./runner.ts";

const DETACHED_PYRUN_LAUNCH_VERSION = 1;
const CONTROL_POLL_MS = 25;
const LAUNCH_MANIFEST_POLL_MS = 10;
const LAUNCH_MANIFEST_TIMEOUT_MS = 30_000;

export interface DetachedPyrunLaunchManifestData {
	artifacts: DetachedJobArtifacts;
	controlDbPath: string;
	identity: DetachedJobLeaseIdentity;
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

type PyrunSettlement =
	| { cancel?: DetachedJobCancelCommand; identity: DetachedJobLeaseIdentity; result: CanonicalPyrunEvalResult }
	| { cancel?: DetachedJobCancelCommand; error: unknown; identity: DetachedJobLeaseIdentity };

export function launchDetachedPyrunRunner(manifestPath: string, options?: { entryPath?: string }): number {
	const entryPath = options?.entryPath ?? defaultRunnerEntryPath();
	const nodeArgs = extname(entryPath) === ".ts" ? ["--experimental-strip-types", entryPath, manifestPath] : [entryPath, manifestPath];
	const child = spawn(process.execPath, nodeArgs, {
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

export async function runDetachedPyrunRunner(manifestPath: string): Promise<{ terminalRevision: number }> {
	const manifest = await waitForDetachedPyrunLaunchManifest(manifestPath);
	const runner = new PyrunRunnerClient(manifest.runnerOptions);
	try {
		const settlement = await waitForDetachedPyrunSettlement(manifest, runner);
		return finalizeDetachedPyrunSettlement(manifest, settlement);
	} finally {
		runner.dispose();
	}
}

async function waitForDetachedPyrunSettlement(
	manifest: DetachedPyrunLaunchManifest,
	runner: PyrunRunnerClient,
): Promise<PyrunSettlement> {
	const abort = new AbortController();
	let identity = manifest.identity;
	let cancel: DetachedJobCancelCommand | undefined;
	const settled = runner
		.evaluate(
			manifest.params,
			(update) => appendArtifactRecord(manifest.artifacts.outputPath, { kind: "progress", update }),
			abort.signal,
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
		if (result) return { ...result, cancel, identity };
		const [command] = claimDetachedJobControlCommands(manifest.controlDbPath, manifest.runnerAddress, identity);
		if (command && !cancel) {
			cancel = command;
			identity = command.identity;
			abort.abort();
		}
	}
}

async function finalizeDetachedPyrunSettlement(
	manifest: DetachedPyrunLaunchManifest,
	settlement: PyrunSettlement,
): Promise<{ terminalRevision: number }> {
	const outcome = pyrunSettlementOutcome(settlement);
	const record = "result" in settlement
		? { kind: "result", result: settlement.result }
		: { error: errorMessage(settlement.error), kind: "error" };
	appendArtifactRecord(manifest.artifacts.outputPath, record);
	writeDetachedJobTerminalEnvelope(manifest.artifacts, settlement.identity, outcome, new Date().toISOString());
	const finalized = await finalizeDetachedEnvelopeWithRetry(
		manifest.artifacts.terminalEnvelopePath,
		(envelopePath) => finalizeDetachedJob(manifest.controlDbPath, { envelopePath, sessionPath: manifest.sessionPath }),
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
