import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { BashOperations } from "../../../src/index.ts";
import { createLocalBashOperations } from "../../../src/index.ts";
import type { SandboxProfileName } from "../../../src/core/permissions/presets.ts";

export type BwrapSandboxProfile = Exclude<SandboxProfileName, "full-access">;

export interface BwrapInvocationOptions {
	bwrapCommand: string;
	command: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	extraReadOnlyPaths?: string[];
	homeDir?: string;
	profile: BwrapSandboxProfile;
}

export interface BwrapInvocation {
	argv: string[];
	command: string;
	env: NodeJS.ProcessEnv;
}

const SANDBOX_HOME = "/tmp/pi-home";
const DEFAULT_LANG = "C.UTF-8";
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/bin:/bin";
const READ_ONLY_SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/nix"];

export function resolveBwrapSandboxProfile(profile: SandboxProfileName): BwrapSandboxProfile | undefined {
	return profile === "full-access" ? undefined : profile;
}

export function runBwrapAvailabilityCheck(bwrapCommand: string): void {
	const result = spawnSync(bwrapCommand, ["--version"], { encoding: "utf8" });
	if (result.error) {
		throw new Error(`bubblewrap is required for sandbox profile but is unavailable: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const stderr = result.stderr.trim();
		throw new Error(`bubblewrap is required for sandbox profile but failed to run${stderr ? `: ${stderr}` : ""}`);
	}
}

export function buildBwrapInvocation(options: BwrapInvocationOptions): BwrapInvocation {
	const cwd = resolve(options.cwd);
	const sandboxEnv = buildSandboxEnv(options.env);
	return {
		argv: buildBwrapArguments(options, cwd, sandboxEnv),
		command: options.bwrapCommand,
		env: sandboxEnv,
	};
}

function buildBwrapArguments(options: BwrapInvocationOptions, cwd: string, sandboxEnv: NodeJS.ProcessEnv): string[] {
	const environmentArguments = Object.entries(sandboxEnv).flatMap(([key, value]) =>
		value === undefined ? [] : ["--setenv", key, value],
	);
	const systemPathArguments = READ_ONLY_SYSTEM_PATHS.flatMap((systemPath) =>
		existsSync(systemPath) ? ["--ro-bind", systemPath, systemPath] : [],
	);
	const readOnlyPathArguments = (options.extraReadOnlyPaths ?? []).flatMap((path) =>
		buildReadOnlyMountArguments(path, cwd),
	);
	const workspaceArguments = buildWorkspaceMountArguments(cwd, options.profile);

	return [
		...buildBwrapBaseArguments(),
		...environmentArguments,
		...systemPathArguments,
		...readOnlyPathArguments,
		...workspaceArguments,
		"--chdir",
		cwd,
		"--",
		...options.command,
	];
}

function buildBwrapBaseArguments(): string[] {
	return [
		"--die-with-parent",
		"--unshare-all",
		"--share-net",
		"--clearenv",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--tmpfs",
		"/tmp",
		"--dir",
		SANDBOX_HOME,
	];
}

export function createSandboxedBashOperations(options: {
	bwrapCommand: string;
	profile: BwrapSandboxProfile | undefined;
	shellPath?: string;
}): BashOperations {
	const localOperations = createLocalBashOperations({ shellPath: options.shellPath });
	const profile = options.profile;
	if (!profile) return localOperations;
	return {
		exec: async (command, cwd, execOptions) => {
			if (execOptions.signal?.aborted) throw new Error("aborted");
			runBwrapAvailabilityCheck(options.bwrapCommand);
			const shellPath = options.shellPath ?? "/bin/sh";
			const invocation = buildBwrapInvocation({
				bwrapCommand: options.bwrapCommand,
				command: [shellPath, "-lc", command],
				cwd,
				env: execOptions.env,
				profile,
			});
			return executeBwrapCommand(invocation, execOptions);
		},
	};
}

export function createBwrapRunnerEnvironment(
	hostEnv: NodeJS.ProcessEnv,
	pythonPath?: string,
): NodeJS.ProcessEnv {
	return {
		LANG: hostEnv.LANG,
		PATH: hostEnv.PATH,
		...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
		TERM: hostEnv.TERM,
		USER: hostEnv.USER,
	};
}

export function createBwrapRunnerCommand(options: {
	bwrapCommand: string;
	cwd: string;
	extraReadOnlyPaths?: string[];
	profile: BwrapSandboxProfile;
	runnerArgs: string[];
	runnerCommand: string;
	runnerEnv?: NodeJS.ProcessEnv;
}): { args: string[]; command: string; env: NodeJS.ProcessEnv } {
	runBwrapAvailabilityCheck(options.bwrapCommand);
	const runnerCommand = findRunnerExecutable(options.runnerCommand, options.runnerEnv);
	const invocation = buildBwrapInvocation({
		bwrapCommand: options.bwrapCommand,
		command: [runnerCommand, ...options.runnerArgs],
		cwd: options.cwd,
		env: options.runnerEnv,
		extraReadOnlyPaths: [
			...(options.extraReadOnlyPaths ?? []),
			...runnerReadOnlyPaths(runnerCommand, options.runnerArgs, options.runnerEnv, options.cwd),
		],
		profile: options.profile,
	});
	return { args: invocation.argv, command: invocation.command, env: invocation.env };
}

function findRunnerExecutable(command: string, env: NodeJS.ProcessEnv | undefined): string {
	if (isAbsolute(command)) return command;
	const searchPath = env?.PATH ?? process.env.PATH ?? DEFAULT_PATH;
	for (const directory of searchPath.split(delimiter)) {
		const candidate = join(directory, command);
		if (existsSync(candidate)) return candidate;
	}
	return command;
}

function runnerReadOnlyPaths(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv | undefined,
	cwd: string,
): string[] {
	const workspace = resolve(cwd);
	const candidatePaths = [
		...(isAbsolute(command) ? [command] : []),
		...args.filter(isAbsolute),
		...(env?.PYTHONPATH?.split(delimiter) ?? []).filter(Boolean),
	];
	const resolvedPaths = candidatePaths
		.map((path) => resolveSandboxPath(path, workspace))
		.filter((path) => !isSandboxMountUnnecessary(path, workspace));
	return [...new Set(resolvedPaths)];
}

function resolveSandboxPath(path: string, workspace: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(workspace, path);
}

function isSandboxMountUnnecessary(path: string, workspace: string): boolean {
	if (!existsSync(path)) return true;
	if (path === workspace || path.startsWith(`${workspace}/`)) return true;
	return READ_ONLY_SYSTEM_PATHS.some((systemPath) => path === systemPath || path.startsWith(`${systemPath}/`));
}

function buildReadOnlyMountArguments(path: string, workspace: string): string[] {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath) || resolvedPath === workspace) return [];
	return [
		...createParentDirectoryArguments(resolvedPath),
		"--ro-bind",
		resolvedPath,
		resolvedPath,
	];
}

function buildWorkspaceMountArguments(workspace: string, profile: BwrapSandboxProfile): string[] {
	if (!existsSync(workspace)) return [];
	const bindMode = profile === "workspace-write" ? "--bind" : "--ro-bind";
	return [...createParentDirectoryArguments(workspace), bindMode, workspace, workspace];
}

function createParentDirectoryArguments(path: string): string[] {
	return deriveParentDirectories(path).flatMap((parent) => ["--dir", parent]);
}

function buildSandboxEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	return {
		HOME: SANDBOX_HOME,
		LANG: env?.LANG ?? DEFAULT_LANG,
		PATH: env?.PATH ?? DEFAULT_PATH,
		TMPDIR: "/tmp",
		XDG_CONFIG_HOME: join(SANDBOX_HOME, ".config"),
		...(env?.PYTHONPATH ? { PYTHONPATH: env.PYTHONPATH } : {}),
		...(env?.TERM ? { TERM: env.TERM } : {}),
		USER: env?.USER ?? process.env.USER,
	};
}

function deriveParentDirectories(path: string): string[] {
	const parts = path.split("/").filter((part) => part.length > 0);
	return Array.from({ length: Math.max(parts.length - 1, 0) }, (_, index) =>
		`/${parts.slice(0, index + 1).join("/")}`,
	);
}

type BwrapExecOptions = Parameters<BashOperations["exec"]>[2];
type BwrapChildProcess = ChildProcessByStdio<null, Readable, Readable>;

function executeBwrapCommand(
	invocation: BwrapInvocation,
	options: BwrapExecOptions,
): Promise<{ exitCode: number | null }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawnBwrapProcess(invocation);
		let timedOut = false;
		const timer = scheduleBwrapTimeout(child, options, () => {
			timedOut = true;
		});
		const onAbort = () => terminateChildProcess(child.pid);
		forwardBwrapOutput(child, options);
		child.on("error", (error) => rejectBwrapExecution(error, timer, reject));
		registerBwrapAbortHandler(options.signal, onAbort);
		child.on("close", (code) =>
			settleBwrapExecution(code, options, timer, onAbort, timedOut, resolvePromise, reject),
		);
	});
}

function spawnBwrapProcess(invocation: BwrapInvocation): BwrapChildProcess {
	return spawn(invocation.command, invocation.argv, {
		detached: process.platform !== "win32",
		env: invocation.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function scheduleBwrapTimeout(
	child: BwrapChildProcess,
	options: BwrapExecOptions,
	markTimedOut: () => void,
): NodeJS.Timeout | undefined {
	const timeoutMs = options.timeout && options.timeout > 0 ? options.timeout * 1000 : undefined;
	return timeoutMs
		? setTimeout(() => {
				markTimedOut();
				terminateChildProcess(child.pid);
			}, timeoutMs)
		: undefined;
}

function forwardBwrapOutput(child: BwrapChildProcess, options: BwrapExecOptions): void {
	child.stdout.on("data", options.onData);
	child.stderr.on("data", options.onData);
}

function registerBwrapAbortHandler(signal: AbortSignal | undefined, onAbort: () => void): void {
	if (!signal) return;
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
}

function rejectBwrapExecution(
	error: Error,
	timer: NodeJS.Timeout | undefined,
	reject: (reason?: unknown) => void,
): void {
	if (timer) clearTimeout(timer);
	reject(error);
}

function settleBwrapExecution(
	code: number | null,
	options: BwrapExecOptions,
	timer: NodeJS.Timeout | undefined,
	onAbort: () => void,
	timedOut: boolean,
	resolvePromise: (value: { exitCode: number | null }) => void,
	reject: (reason?: unknown) => void,
): void {
	if (timer) clearTimeout(timer);
	options.signal?.removeEventListener("abort", onAbort);
	if (options.signal?.aborted) reject(new Error("aborted"));
	else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
	else resolvePromise({ exitCode: code });
}

function terminateChildProcess(pid: number | undefined): void {
	if (!pid) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already exited.
		}
	}
}
