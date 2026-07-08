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

/**
 * Restart request consumed from the environment at startup. `oldPid` equals the
 * current pid after an exec-in-place restart and the parent pid after a spawn
 * handoff on platforms without process.execve.
 */
export interface SelfRestartHandoff {
	sessionFile: string;
	prompt?: string;
	oldPid?: number;
}

type ExecveFunction = (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => void;

interface RestartTargetDependencies {
	argv?: readonly string[];
	argv0?: string;
	execArgv?: readonly string[];
}

interface SelfRestartDependencies extends RestartTargetDependencies {
	spawn?: (
		command: string,
		args: readonly string[],
		options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
	) => RestartChildProcess;
	waitForExit?: boolean;
}

interface RestartChildProcess extends EventEmitter {
	unref?: () => void;
}

export interface RestartCurrentProcessDependencies extends RestartTargetDependencies {
	execve?: ExecveFunction;
	exit?: (code: number) => never;
	spawnSelfRestart?: (request: SelfRestartRequest, dependencies?: SelfRestartDependencies) => Promise<number>;
}

export type ProcessRestarter = (
	request: SelfRestartRequest,
	dependencies?: RestartCurrentProcessDependencies,
) => Promise<never>;

interface WaitForSelfRestartParentExitDependencies {
	currentPid?: number;
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

/**
 * Reads and removes the self-restart request from the environment. Consuming
 * eagerly keeps the request variables out of every child process the restarted
 * Pi spawns, so a sub-agent Pi cannot mistake the leaked request for its own.
 *
 * A request whose old pid matches neither the current process (exec-in-place)
 * nor the parent process (spawn handoff) leaked from an unrelated process and
 * is discarded.
 */
export function consumeSelfRestartRequest(
	env: NodeJS.ProcessEnv = process.env,
	currentPid: number = process.pid,
	parentPid: number = process.ppid,
): SelfRestartHandoff | undefined {
	const requested = env[ENV_SELF_RESTART_REQUEST] === "1";
	const sessionFile = env[ENV_SELF_RESTART_SESSION];
	const prompt = env[ENV_SELF_RESTART_PROMPT];
	const oldPidRaw = env[ENV_SELF_RESTART_OLD_PID];
	delete env[ENV_SELF_RESTART_REQUEST];
	delete env[ENV_SELF_RESTART_SESSION];
	delete env[ENV_SELF_RESTART_PROMPT];
	delete env[ENV_SELF_RESTART_OLD_PID];

	if (!requested || !sessionFile) {
		return undefined;
	}
	let oldPid: number | undefined;
	if (oldPidRaw) {
		oldPid = Number(oldPidRaw);
		const isValidPid = Number.isSafeInteger(oldPid) && oldPid > 0;
		const isOwnRestart = oldPid === currentPid || oldPid === parentPid;
		if (!isValidPid || !isOwnRestart) {
			return undefined;
		}
	}
	return { sessionFile, prompt: prompt || undefined, oldPid };
}

export async function waitForSelfRestartParentExit(
	handoff: SelfRestartHandoff | undefined,
	dependencies: WaitForSelfRestartParentExitDependencies = {},
): Promise<void> {
	const oldPid = handoff?.oldPid;
	const currentPid = dependencies.currentPid ?? process.pid;
	if (!oldPid || oldPid === currentPid) {
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

export function applySelfRestartRequest(parsed: Args, handoff: SelfRestartHandoff | undefined): void {
	if (!handoff) {
		return;
	}

	parsed.session = handoff.sessionFile;
	parsed.resume = false;
	parsed.continue = true;
	parsed.fork = undefined;
	parsed.noSession = false;
	parsed.sessionId = undefined;
	parsed.fileArgs = [];
	parsed.messages = handoff.prompt ? [handoff.prompt] : [];
}

export function appendSelfRestartNotice(sessionManager: SessionManager, handoff: SelfRestartHandoff | undefined): void {
	if (!handoff?.prompt) {
		return;
	}

	sessionManager.appendCustomMessageEntry("self_restart", formatRestartNotice(handoff), true);
}

function formatRestartNotice(handoff: SelfRestartHandoff): string {
	if (!handoff.oldPid || handoff.oldPid === process.pid) {
		return `${handoff.prompt} PID: ${process.pid}.`;
	}
	return `${handoff.prompt} PID ${handoff.oldPid} -> ${process.pid}.`;
}

/**
 * Replaces the current process image via execve, or hands off to a spawned
 * replacement on platforms without process.execve (Windows, Node < 23.11).
 *
 * exec-in-place is required under shell job control: a spawned replacement
 * whose parent exits lands in an orphaned background process group, where
 * tcsetattr (raw mode) always fails with EIO. exec keeps the pid, the
 * foreground process group, and the controlling terminal.
 */
export async function restartCurrentProcess(
	request: SelfRestartRequest,
	dependencies: RestartCurrentProcessDependencies = {},
): Promise<never> {
	const restartRequest = { ...request, oldPid: process.pid };
	const execve = "execve" in dependencies ? dependencies.execve : process.execve;
	if (typeof execve === "function") {
		execSelfRestart(restartRequest, execve, dependencies);
		throw new Error("execve returned after replacing the process image");
	}

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

function buildSelfRestartEnv(request: SelfRestartRequest): NodeJS.ProcessEnv {
	return {
		...process.env,
		[ENV_SELF_RESTART_REQUEST]: "1",
		[ENV_SELF_RESTART_SESSION]: request.sessionFile,
		[ENV_SELF_RESTART_PROMPT]: request.prompt ?? "",
		[ENV_SELF_RESTART_OLD_PID]: request.oldPid?.toString() ?? process.pid.toString(),
	};
}

function execSelfRestart(
	request: SelfRestartRequest,
	execve: ExecveFunction,
	dependencies: RestartTargetDependencies,
): void {
	const argv = dependencies.argv ?? process.argv;
	const execArgv = dependencies.execArgv ?? process.execArgv;
	const argv0 = dependencies.argv0 ?? process.argv0;
	execve(process.execPath, [argv0, ...getSelfRestartArgs(execArgv, argv)], buildSelfRestartEnv(request));
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
		env: buildSelfRestartEnv(request),
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
