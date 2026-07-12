import { spawn } from "node:child_process";
import { closeSync, constants, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import { readProcessIdentity } from "./runtime-process.ts";

const PAYLOAD_GATE_SCRIPT = 'IFS= read -r _ <&3 || exit 125; exec "$@"';

export interface GatedDetachedPayloadInput {
	args: string[];
	command: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	identityPath: string;
	stderrPath: string;
	stdoutPath: string;
}

export interface GatedDetachedPayloadExit {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

export interface GatedDetachedPayload {
	pid: number;
	persistIdentity(): void;
	release(): void;
	waitForExit(): Promise<GatedDetachedPayloadExit>;
}

export function spawnGatedDetachedPayload(input: GatedDetachedPayloadInput): GatedDetachedPayload {
	const outputDescriptor = openSharedOutputFile(input.stdoutPath, input.stderrPath);
	const child = spawn("/bin/sh", ["-c", PAYLOAD_GATE_SCRIPT, "pi-detached-gate", input.command, ...input.args], {
		cwd: input.cwd,
		detached: true,
		env: input.env,
		stdio: ["ignore", outputDescriptor, outputDescriptor, "pipe"],
	});
	closeSync(outputDescriptor);
	if (!child.pid) throw new Error(`Could not start detached payload: ${input.command}`);
	const pid = child.pid;
	const gate = child.stdio[3] as Writable | null;
	if (!gate) throw new Error("Detached payload gate is unavailable");
	const exit = new Promise<GatedDetachedPayloadExit>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
	});
	let identityPersisted = false;
	let released = false;
	return {
		pid,
		persistIdentity: () => {
			persistPayloadIdentity(input.identityPath, pid);
			identityPersisted = true;
		},
		release: () => {
			if (!identityPersisted) throw new Error("Detached payload identity must be persisted before release");
			if (released) throw new Error("Detached payload gate was already released");
			released = true;
			gate.end("run\n");
		},
		waitForExit: () => exit,
	};
}

function openSharedOutputFile(stdoutPath: string, stderrPath: string): number {
	if (stdoutPath !== stderrPath) throw new Error("Split detached payload output is not implemented");
	return openSync(stdoutPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND, 0o600);
}

function persistPayloadIdentity(path: string, pid: number): void {
	const processIdentity = readProcessIdentity(pid);
	const identity = {
		pgid: readLinuxProcessGroupId(pid),
		...processIdentity,
	};
	const temporaryPath = `${path}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(identity)}\n`, { encoding: "utf8", mode: 0o600 });
	fsyncFile(temporaryPath);
	renameSync(temporaryPath, path);
	fsyncDirectory(dirname(path));
}

function readLinuxProcessGroupId(pid: number): number {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const commandEnd = stat.lastIndexOf(")");
	if (commandEnd < 0) throw new Error(`Invalid /proc stat for detached payload ${pid}`);
	const fields = stat
		.slice(commandEnd + 2)
		.trim()
		.split(/\s+/);
	const processGroupId = Number(fields[2]);
	if (!Number.isSafeInteger(processGroupId)) throw new Error(`Invalid process group for detached payload ${pid}`);
	return processGroupId;
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
