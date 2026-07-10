import { spawn, spawnSync } from "node:child_process";
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

export function assertBwrapAvailable(bwrapCommand: string): void {
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
	const argv = ["--die-with-parent", "--unshare-all", "--share-net", "--clearenv"];
	for (const [key, value] of Object.entries(sandboxEnv)) {
		if (value !== undefined) argv.push("--setenv", key, value);
	}
	for (const systemPath of READ_ONLY_SYSTEM_PATHS) {
		if (existsSync(systemPath)) argv.push("--ro-bind", systemPath, systemPath);
	}
	argv.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--dir", SANDBOX_HOME);

	for (const readOnlyPath of options.extraReadOnlyPaths ?? []) {
		appendReadOnlyMount(argv, readOnlyPath, cwd);
	}

	appendWorkspaceMount(argv, cwd, options.profile);

	argv.push("--chdir", cwd, "--", ...options.command);
	return {
		argv,
		command: options.bwrapCommand,
		env: sandboxEnv,
	};
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
			assertBwrapAvailable(options.bwrapCommand);
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
	assertBwrapAvailable(options.bwrapCommand);
	const runnerCommand = resolveRunnerExecutable(options.runnerCommand, options.runnerEnv);
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

function resolveRunnerExecutable(command: string, env: NodeJS.ProcessEnv | undefined): string {
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
	const paths = new Set<string>();
	const addPath = (path: string) => {
		const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
		if (isProvidedByExistingSandboxMount(resolvedPath, workspace)) return;
		paths.add(resolvedPath);
	};
	if (isAbsolute(command)) addPath(command);
	for (const arg of args) {
		if (isAbsolute(arg)) addPath(arg);
	}
	for (const path of env?.PYTHONPATH?.split(delimiter) ?? []) {
		if (path) addPath(path);
	}
	return [...paths];
}

function isProvidedByExistingSandboxMount(path: string, workspace: string): boolean {
	if (!existsSync(path)) return true;
	if (path === workspace || path.startsWith(`${workspace}/`)) return true;
	return READ_ONLY_SYSTEM_PATHS.some((systemPath) => path === systemPath || path.startsWith(`${systemPath}/`));
}

function appendReadOnlyMount(argv: string[], path: string, workspace: string): void {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath) || resolvedPath === workspace) return;
	appendParentDirectories(argv, resolvedPath);
	argv.push("--ro-bind", resolvedPath, resolvedPath);
}

function appendWorkspaceMount(argv: string[], workspace: string, profile: BwrapSandboxProfile): void {
	if (!existsSync(workspace)) return;
	appendParentDirectories(argv, workspace);
	const bindMode = profile === "workspace-write" ? "--bind" : "--ro-bind";
	argv.push(bindMode, workspace, workspace);
}

function appendParentDirectories(argv: string[], path: string): void {
	for (const parent of parentDirectories(path)) argv.push("--dir", parent);
}

function buildSandboxEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	const sandboxEnv: NodeJS.ProcessEnv = {
		HOME: SANDBOX_HOME,
		LANG: env?.LANG ?? DEFAULT_LANG,
		PATH: env?.PATH ?? DEFAULT_PATH,
		TMPDIR: "/tmp",
		XDG_CONFIG_HOME: join(SANDBOX_HOME, ".config"),
	};
	if (env?.PYTHONPATH) sandboxEnv.PYTHONPATH = env.PYTHONPATH;
	if (env?.TERM) sandboxEnv.TERM = env.TERM;
	sandboxEnv.USER = env?.USER ?? process.env.USER;
	return sandboxEnv;
}

function parentDirectories(path: string): string[] {
	const parts = path.split("/").filter((part) => part.length > 0);
	const parents: string[] = [];
	for (let index = 1; index < parts.length; index += 1) {
		parents.push(`/${parts.slice(0, index).join("/")}`);
	}
	return parents;
}

function executeBwrapCommand(
	invocation: BwrapInvocation,
	options: Parameters<BashOperations["exec"]>[2],
): Promise<{ exitCode: number | null }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(invocation.command, invocation.argv, {
			detached: process.platform !== "win32",
			env: invocation.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let timedOut = false;
		const timeoutMs = options.timeout && options.timeout > 0 ? options.timeout * 1000 : undefined;
		const timer = timeoutMs
			? setTimeout(() => {
					timedOut = true;
					killChild(child.pid);
				}, timeoutMs)
			: undefined;
		const onAbort = () => killChild(child.pid);
		child.stdout.on("data", options.onData);
		child.stderr.on("data", options.onData);
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			reject(error);
		});
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (options.signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
			else resolvePromise({ exitCode: code });
		});
	});
}

function killChild(pid: number | undefined): void {
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
