import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentFileReference, AgentSnapshot } from "./multi-agent-store.ts";
import type { ProcessIdentity } from "./runtime-process.ts";
import type { MultiAgentRuntimeOwnership } from "./session-control-db.ts";

export interface DetachedJobOwnershipIdentity {
	jobId: string;
	owner: { sessionId: string; agentId: string | null };
	processIdentity: ProcessIdentity;
	outputLabel: string;
}

export type DetachedJobOutcome =
	| { kind: "completed"; exitCode?: number; summary?: string }
	| { kind: "failed"; error: { code?: string; message: string }; exitCode?: number }
	| { kind: "aborted"; reason?: string };

export interface DetachedJobArtifacts {
	directory: string;
	outputPath: string;
}

export interface DetachedJobTerminalInput extends DetachedJobOwnershipIdentity {
	terminalAt: string;
	toolCallId?: string;
	durationMs?: number;
	outcome: DetachedJobOutcome;
	output: { label: string; path: string; size: number; sha256: string };
}

export interface DetachedJobOwnership {
	agent: AgentSnapshot;
	artifacts: DetachedJobArtifacts;
	controlOwnership: MultiAgentRuntimeOwnership;
	identity: DetachedJobOwnershipIdentity;
}

export interface RegisterDetachedJobInput {
	agentType: "bash" | "pyrun";
	cwd: string;
	displayName: string;
	jobId: string;
	processIdentity: ProcessIdentity;
	workerHandleId: string;
	/** Originating tool call in the owning agent, recorded on the detached job's worker. */
	toolCallId?: string;
	/** True when the job is already detached from its waiting tool call at registration. */
	detached?: boolean;
	/** Durable input artifacts exposed alongside the output log. */
	fileRefs?: AgentFileReference[];
}

export type DetachedJobLifecycleCommandResult =
	| { ok: true; agent: AgentSnapshot }
	| { ok: false; error: "agent_not_found" | "invalid_transition" | "mutation_mismatch" };

export interface LaunchDetachedBashInput {
	args: string[];
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
	toolCallId?: string;
}

export interface LaunchedDetachedBashJob {
	manifestPath: string;
	ownership: DetachedJobOwnership;
	runnerPid: number;
}

export interface DetachedJobLifecycleController {
	allocateJobId(agentType: "bash" | "pyrun"): string;
	cancel(ownership: DetachedJobOwnership, reason?: string): DetachedJobLifecycleCommandResult;
	createArtifacts(jobId: string): DetachedJobArtifacts;
	findBashJobByToolCallId(toolCallId: string): AgentSnapshot | undefined;
	launchBash(input: LaunchDetachedBashInput): LaunchedDetachedBashJob;
	markDetached(ownership: DetachedJobOwnership): DetachedJobLifecycleCommandResult;
	observe(jobId: string): AgentSnapshot | undefined;
	register(input: RegisterDetachedJobInput): DetachedJobOwnership;
}

export interface DetachedJobRunnerContract {
	artifacts: DetachedJobArtifacts;
	identity: DetachedJobOwnershipIdentity;
	cancel(reason?: string): void;
}

export function createDetachedJobArtifacts(rootDirectory: string, jobId: string): DetachedJobArtifacts {
	const directory = detachedJobDirectory(rootDirectory, jobId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return { directory, outputPath: join(directory, "output.log") };
}

export function reserveDetachedJobArtifacts(rootDirectory: string, jobId: string): DetachedJobArtifacts {
	const directory = detachedJobDirectory(rootDirectory, jobId);
	mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
	try {
		mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`Detached job artifact directory already exists: ${directory}`);
		}
		throw error;
	}
	return { directory, outputPath: join(directory, "output.log") };
}

function detachedJobDirectory(rootDirectory: string, jobId: string): string {
	if (!jobId || jobId.includes("/") || jobId.includes("\\")) {
		throw new Error("Detached job ID must be one path segment");
	}
	return join(rootDirectory, jobId);
}

export function createDetachedJobTerminalInput(
	artifacts: DetachedJobArtifacts,
	identity: DetachedJobOwnershipIdentity,
	outcome: DetachedJobOutcome,
	terminalAt: string,
	durationMs?: number,
	toolCallId?: string,
): DetachedJobTerminalInput {
	fsyncPath(artifacts.outputPath);
	const data = readFileSync(artifacts.outputPath);
	return {
		...identity,
		...(durationMs === undefined ? {} : { durationMs }),
		...(toolCallId === undefined ? {} : { toolCallId }),
		outcome,
		output: {
			label: identity.outputLabel,
			path: artifacts.outputPath,
			sha256: createHash("sha256").update(data).digest("hex"),
			size: statSync(artifacts.outputPath).size,
		},
		terminalAt,
	};
}

function fsyncPath(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
