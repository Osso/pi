import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnGatedDetachedPayload } from "./detached-job-bootstrap.ts";
import {
	type DetachedJobArtifacts,
	type DetachedJobLeaseIdentity,
	type DetachedJobOutcome,
	writeDetachedJobTerminalEnvelope,
} from "./detached-job-runner.ts";
import { finalizeDetachedJob } from "./session-control-db.ts";

const DETACHED_BASH_LAUNCH_VERSION = 1;

export interface DetachedBashLaunchManifestData {
	args: string[];
	artifacts: DetachedJobArtifacts;
	command: string;
	controlDbPath: string;
	cwd: string;
	identity: DetachedJobLeaseIdentity;
	sessionPath: string;
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
	const manifest = readDetachedBashLaunchManifest(manifestPath);
	const payload = spawnGatedDetachedPayload({
		args: manifest.args,
		command: manifest.command,
		cwd: manifest.cwd,
		identityPath: join(manifest.artifacts.directory, "payload.json"),
		stderrPath: manifest.artifacts.outputPath,
		stdoutPath: manifest.artifacts.outputPath,
	});
	payload.persistIdentity();
	payload.release();
	const exited = await payload.waitForExit();
	const outcome = detachedBashOutcome(exited.exitCode, exited.signal);
	const terminalAt = options?.now?.() ?? new Date().toISOString();
	writeDetachedJobTerminalEnvelope(manifest.artifacts, manifest.identity, outcome, terminalAt);
	const finalized = await finalizeDetachedEnvelopeWithRetry(manifest.artifacts.terminalEnvelopePath, (envelopePath) =>
		finalizeDetachedJob(manifest.controlDbPath, { envelopePath, sessionPath: manifest.sessionPath }),
	);
	if (!finalized.ok) throw new Error(`Could not finalize detached Bash job: ${finalized.error}`);
	return { exitCode: exited.exitCode, terminalRevision: finalized.terminalRevision };
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
