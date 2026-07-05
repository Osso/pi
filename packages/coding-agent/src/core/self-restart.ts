import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Args } from "../cli/args.ts";
import type { SessionManager } from "./session-manager.ts";

export const ENV_SELF_RESTART_REQUEST = "PI_SELF_RESTART_REQUEST";
export const ENV_SELF_RESTART_SESSION = "PI_SELF_RESTART_SESSION";
export const ENV_SELF_RESTART_PROMPT = "PI_SELF_RESTART_PROMPT";
export const ENV_SELF_RESTART_OLD_PID = "PI_SELF_RESTART_OLD_PID";
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
	spawnSelfRestart?: (request: SelfRestartRequest) => Promise<number>;
}

export type ProcessRestarter = (
	request: SelfRestartRequest,
	dependencies?: RestartCurrentProcessDependencies,
) => Promise<never>;

export function applySelfRestartRequest(parsed: Args, env: NodeJS.ProcessEnv = process.env): void {
	if (env[ENV_SELF_RESTART_REQUEST] !== "1") {
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
	const exitCode = await spawnRestart(restartRequest);
	exit(exitCode);
	throw new Error("process.exit returned after spawning restart process");
}

export function spawnSelfRestart(
	request: SelfRestartRequest,
	dependencies: SelfRestartDependencies = {},
): Promise<number> {
	const spawnProcess = dependencies.spawn ?? spawn;
	const argv = dependencies.argv ?? process.argv;
	const execArgv = dependencies.execArgv ?? process.execArgv;
	const child = spawnProcess(process.execPath, [...execArgv, ...argv.slice(1)], {
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
