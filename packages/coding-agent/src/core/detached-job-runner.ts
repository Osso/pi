import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentSnapshot } from "./multi-agent-store.ts";
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
}

export interface LaunchedDetachedBashJob {
	manifestPath: string;
	ownership: DetachedJobOwnership;
	runnerPid: number;
}

export interface DetachedJobLifecycleController {
	allocateJobId(): string;
	cancel(ownership: DetachedJobOwnership, reason?: string): DetachedJobLifecycleCommandResult;
	createArtifacts(jobId: string): DetachedJobArtifacts;
	launchBash(input: LaunchDetachedBashInput): LaunchedDetachedBashJob;
	observe(jobId: string): AgentSnapshot | undefined;
	register(input: RegisterDetachedJobInput): DetachedJobOwnership;
}

export interface DetachedJobRunnerContract {
	artifacts: DetachedJobArtifacts;
	identity: DetachedJobOwnershipIdentity;
	cancel(reason?: string): void;
}

export function createDetachedJobArtifacts(rootDirectory: string, jobId: string): DetachedJobArtifacts {
	if (!jobId || jobId.includes("/") || jobId.includes("\\"))
		throw new Error("Detached job ID must be one path segment");
	const directory = join(rootDirectory, jobId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return { directory, outputPath: join(directory, "output.log") };
}

export function createDetachedJobTerminalInput(
	artifacts: DetachedJobArtifacts,
	identity: DetachedJobOwnershipIdentity,
	outcome: DetachedJobOutcome,
	terminalAt: string,
	durationMs?: number,
): DetachedJobTerminalInput {
	fsyncPath(artifacts.outputPath);
	const data = readFileSync(artifacts.outputPath);
	return {
		...identity,
		...(durationMs === undefined ? {} : { durationMs }),
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
