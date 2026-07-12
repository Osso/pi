import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSnapshot } from "./multi-agent-store.ts";

const DETACHED_JOB_ENVELOPE_VERSION = 1;

export interface DetachedJobLeaseIdentity {
	jobId: string;
	expectedRevision: number;
	leaseId: string;
	runtimeIncarnation: string;
	fencingEpoch: number;
}

export type DetachedJobOutcome =
	| { kind: "completed"; exitCode?: number; summary?: string }
	| { kind: "failed"; error: { code?: string; message: string }; exitCode?: number }
	| { kind: "aborted"; reason?: string };

export interface DetachedJobArtifacts {
	directory: string;
	outputPath: string;
	terminalEnvelopePath: string;
}

export interface DetachedJobTerminalEnvelope extends DetachedJobLeaseIdentity {
	version: typeof DETACHED_JOB_ENVELOPE_VERSION;
	terminalAt: string;
	outcome: DetachedJobOutcome;
	output: { path: string; size: number; sha256: string };
	checksum: string;
}

export interface DetachedJobReservation {
	agent: AgentSnapshot;
	artifacts: DetachedJobArtifacts;
	identity: DetachedJobLeaseIdentity;
}

export interface ReserveDetachedJobInput {
	agentType: "bash" | "pyrun";
	cwd: string;
	displayName: string;
	jobId: string;
	workerHandleId: string;
}

export interface DetachedJobLifecycleController {
	allocateJobId(): string;
	createArtifacts(jobId: string): DetachedJobArtifacts;
	reserve(input: ReserveDetachedJobInput): DetachedJobReservation;
	publish(agent: AgentSnapshot): void;
	finalize(envelopePath: string): { ok: boolean; terminalRevision?: number; error?: string };
}

export interface DetachedJobRunnerContract {
	artifacts: DetachedJobArtifacts;
	identity: DetachedJobLeaseIdentity;
	cancel(reason?: string): void;
}

export function createDetachedJobArtifacts(rootDirectory: string, jobId: string): DetachedJobArtifacts {
	if (!jobId || jobId.includes("/") || jobId.includes("\\"))
		throw new Error("Detached job ID must be one path segment");
	const directory = join(rootDirectory, jobId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return {
		directory,
		outputPath: join(directory, "output.log"),
		terminalEnvelopePath: join(directory, "terminal.json"),
	};
}

export function writeDetachedJobTerminalEnvelope(
	artifacts: DetachedJobArtifacts,
	identity: DetachedJobLeaseIdentity,
	outcome: DetachedJobOutcome,
	terminalAt: string,
): DetachedJobTerminalEnvelope {
	fsyncPath(artifacts.outputPath);
	const output = readOutputIntegrity(artifacts.outputPath);
	const unsigned: Omit<DetachedJobTerminalEnvelope, "checksum"> = {
		...identity,
		outcome,
		output,
		terminalAt,
		version: DETACHED_JOB_ENVELOPE_VERSION,
	};
	const envelope: DetachedJobTerminalEnvelope = { ...unsigned, checksum: hashCanonicalJson(unsigned) };
	const temporaryPath = `${artifacts.terminalEnvelopePath}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
	fsyncPath(temporaryPath);
	renameSync(temporaryPath, artifacts.terminalEnvelopePath);
	fsyncDirectory(dirname(artifacts.terminalEnvelopePath));
	return envelope;
}

export function readDetachedJobTerminalEnvelope(path: string): DetachedJobTerminalEnvelope {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as DetachedJobTerminalEnvelope;
	const { checksum, ...unsigned } = parsed;
	if (parsed.version !== DETACHED_JOB_ENVELOPE_VERSION || checksum !== hashCanonicalJson(unsigned)) {
		throw new Error(`Invalid detached job terminal envelope: ${path}`);
	}
	const output = readOutputIntegrity(parsed.output.path);
	if (output.size !== parsed.output.size || output.sha256 !== parsed.output.sha256) {
		throw new Error(`Detached job output integrity mismatch: ${parsed.output.path}`);
	}
	return parsed;
}

function readOutputIntegrity(path: string): DetachedJobTerminalEnvelope["output"] {
	const data = readFileSync(path);
	return { path, size: statSync(path).size, sha256: createHash("sha256").update(data).digest("hex") };
}

function hashCanonicalJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fsyncPath(path: string): void {
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
