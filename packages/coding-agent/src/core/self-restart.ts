import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Args } from "../cli/args.ts";
import type { SessionManager } from "./session-manager.ts";

export const ENV_SELF_RESTART_REQUEST = "PI_SELF_RESTART_REQUEST";
export const ENV_SELF_RESTART_SESSION = "PI_SELF_RESTART_SESSION";
export const ENV_SELF_RESTART_PROMPT = "PI_SELF_RESTART_PROMPT";
export const ENV_SELF_RESTART_OLD_PID = "PI_SELF_RESTART_OLD_PID";
const SELF_RESTART_PARENT_EXIT_TIMEOUT_MS = 5000;
const SELF_RESTART_PARENT_EXIT_POLL_MS = 25;

export interface SelfRestartRequest {
	sessionFile: string;
	prompt?: string;
	oldPid?: number;
}

interface RestartChildProcess extends EventEmitter {
	unref?: () => void;
}

interface SelfRestartDependencies {
	spawn?: (
		command: string,
		args: readonly string[],
		options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
	) => RestartChildProcess;
	argv?: readonly string[];
	execArgv?: readonly string[];
	waitForExit?: boolean;
}

export interface RestartCurrentProcessDependencies {
	exit?: (code: number) => never;
	spawnSelfRestart?: (request: SelfRestartRequest, dependencies?: SelfRestartDependencies) => Promise<number>;
}

export type ProcessRestarter = (
	request: SelfRestartRequest,
	dependencies?: RestartCurrentProcessDependencies,
) => Promise<never>;

interface WaitForSelfRestartParentExitDependencies {
	env?: NodeJS.ProcessEnv;
	isProcessAlive?: (pid: number) => boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForSelfRestartParentExit(
	dependencies: WaitForSelfRestartParentExitDependencies = {},
): Promise<void> {
	const env = dependencies.env ?? process.env;
	if (env[ENV_SELF_RESTART_REQUEST] !== "1") {
		return;
	}
	const oldPid = Number(env[ENV_SELF_RESTART_OLD_PID]);
	if (!Number.isSafeInteger(oldPid) || oldPid <= 0) {
		return;
	}

	const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
	const now = dependencies.now ?? Date.now;
	const wait = dependencies.sleep ?? sleep;
	const deadline = now() + SELF_RESTART_PARENT_EXIT_TIMEOUT_MS;
	while (isProcessAlive(oldPid) && now() < deadline) {
		await wait(SELF_RESTART_PARENT_EXIT_POLL_MS);
	}
}

export function applySelfRestartRequest(parsed: Args, env: NodeJS.ProcessEnv = process.env): void {
	if (env[ENV_SELF_RESTART_REQUEST] !== "1") {
		return;
	}
	const oldPid = env[ENV_SELF_RESTART_OLD_PID];
	if (oldPid && oldPid !== process.ppid.toString()) {
		return;
	}
	const sessionFile = env[ENV_SELF_RESTART_SESSION];
	if (!sessionFile) {
		return;
	}

	parsed.session = sessionFile;
	parsed.resume = false;
	parsed.continue = true;
	parsed.fork = undefined;
	parsed.noSession = false;
	parsed.sessionId = undefined;
	parsed.fileArgs = [];
	const prompt = env[ENV_SELF_RESTART_PROMPT];
	parsed.messages = prompt ? [prompt] : [];
}

export function appendSelfRestartNotice(sessionManager: SessionManager, env: NodeJS.ProcessEnv = process.env): void {
	const prompt = env[ENV_SELF_RESTART_PROMPT];
	if (!prompt) {
		return;
	}

	sessionManager.appendCustomMessageEntry("self_restart", formatRestartNotice(prompt, env), true);
}

function formatRestartNotice(prompt: string, env: NodeJS.ProcessEnv): string {
	const oldPid = env[ENV_SELF_RESTART_OLD_PID];
	if (!oldPid) {
		return `${prompt} New PID: ${process.pid}.`;
	}
	return `${prompt} PID ${oldPid} -> ${process.pid}.`;
}

export async function restartCurrentProcess(
	request: SelfRestartRequest,
	dependencies: RestartCurrentProcessDependencies = {},
): Promise<never> {
	const restartRequest = { ...request, oldPid: process.pid };
	const exit = dependencies.exit ?? process.exit;
	const spawnRestart = dependencies.spawnSelfRestart ?? spawnSelfRestart;
	const exitCode = await spawnRestart(restartRequest, { waitForExit: false });
	exit(exitCode);
	throw new Error("process.exit returned after spawning restart process");
}

const BUN_VIRTUAL_ENTRYPOINT_PREFIXES = ["/$bunfs/root/", "/~BUN/root/", "/%7EBUN/root/"];

function isBunVirtualEntrypoint(path: string | undefined): boolean {
	return path !== undefined && BUN_VIRTUAL_ENTRYPOINT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function getSelfRestartArgs(execArgv: readonly string[], argv: readonly string[]): string[] {
	const firstRealArgIndex = argv.findIndex((arg, index) => index > 0 && !isBunVirtualEntrypoint(arg));
	const scriptArgs = firstRealArgIndex === -1 ? [] : argv.slice(firstRealArgIndex);
	return [...execArgv, ...scriptArgs];
}

export function spawnSelfRestart(
	request: SelfRestartRequest,
	dependencies: SelfRestartDependencies = {},
): Promise<number> {
	const spawnProcess = dependencies.spawn ?? spawn;
	const argv = dependencies.argv ?? process.argv;
	const execArgv = dependencies.execArgv ?? process.execArgv;
	const child = spawnProcess(process.execPath, getSelfRestartArgs(execArgv, argv), {
		cwd: process.cwd(),
		env: {
			...process.env,
			[ENV_SELF_RESTART_REQUEST]: "1",
			[ENV_SELF_RESTART_SESSION]: request.sessionFile,
			[ENV_SELF_RESTART_PROMPT]: request.prompt ?? "",
			[ENV_SELF_RESTART_OLD_PID]: request.oldPid?.toString() ?? process.pid.toString(),
		},
		stdio: "inherit",
	});
	if (dependencies.waitForExit === false) {
		child.unref?.();
		return Promise.resolve(0);
	}
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code: number | null) => {
			resolve(code ?? 0);
		});
	});
}
