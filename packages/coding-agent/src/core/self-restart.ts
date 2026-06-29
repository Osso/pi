import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import type { Args } from "../cli/args.ts";
import type { SessionManager } from "./session-manager.ts";

export const ENV_SELF_RESTART_SESSION = "PI_SELF_RESTART_SESSION";
export const ENV_SELF_RESTART_PROMPT = "PI_SELF_RESTART_PROMPT";
export const ENV_SELF_RESTART_OLD_PID = "PI_SELF_RESTART_OLD_PID";
export const ENV_RESTART_EXIT_CODE = "PI_RESTART_EXIT_CODE";
export const ENV_RESTART_REQUEST_FILE = "PI_RESTART_REQUEST_FILE";

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
	waitForExit?: boolean;
}

export interface RestartCurrentProcessDependencies {
	appendNotice?: () => void;
	dispose?: () => Promise<void>;
	env?: NodeJS.ProcessEnv;
	exit?: (code: number) => never;
	spawnSelfRestart?: (request: SelfRestartRequest) => Promise<number>;
}

export type ProcessRestarter = (
	request: SelfRestartRequest,
	dependencies?: RestartCurrentProcessDependencies,
) => Promise<never>;

export function getRestartExitCode(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const rawExitCode = env[ENV_RESTART_EXIT_CODE];
	if (!rawExitCode) {
		return undefined;
	}

	const exitCode = Number(rawExitCode);
	if (!Number.isInteger(exitCode) || exitCode < 1 || exitCode > 255) {
		throw new Error(`${ENV_RESTART_EXIT_CODE} must be an integer from 1 to 255`);
	}
	return exitCode;
}

export function applySelfRestartRequest(parsed: Args, env: NodeJS.ProcessEnv = process.env): void {
	const sessionFile = env[ENV_SELF_RESTART_SESSION];
	if (!sessionFile) {
		return;
	}

	parsed.session = sessionFile;
	parsed.resume = false;
	parsed.continue = false;
	parsed.fork = undefined;
	parsed.noSession = false;
	parsed.sessionId = undefined;
	parsed.fileArgs = [];
	parsed.messages = [];
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

export function writeWrapperRestartRequest(request: SelfRestartRequest, env: NodeJS.ProcessEnv = process.env): void {
	const requestFile = env[ENV_RESTART_REQUEST_FILE];
	if (!requestFile) {
		return;
	}

	writeFileSync(requestFile, `${JSON.stringify(request)}\n`, "utf8");
}

export async function restartCurrentProcess(
	request: SelfRestartRequest,
	dependencies: RestartCurrentProcessDependencies = {},
): Promise<never> {
	const restartRequest = { ...request, oldPid: process.pid };
	const env = dependencies.env ?? process.env;
	const exit = dependencies.exit ?? process.exit;
	const wrapperExitCode = getRestartExitCode(env);
	if (wrapperExitCode !== undefined) {
		writeWrapperRestartRequest(restartRequest, env);
		exit(wrapperExitCode);
		throw new Error("process.exit returned after wrapper restart request");
	}

	const spawnRestart =
		dependencies.spawnSelfRestart ??
		((childRequest: SelfRestartRequest) => spawnSelfRestart(childRequest, { waitForExit: false }));
	await spawnRestart(restartRequest);
	exit(0);
	throw new Error("process.exit returned after spawning restart process");
}

export function spawnSelfRestart(
	request: SelfRestartRequest,
	dependencies: SelfRestartDependencies = {},
): Promise<number> {
	const spawnProcess = dependencies.spawn ?? spawn;
	const child = spawnProcess(process.execPath, process.argv.slice(1), {
		cwd: process.cwd(),
		env: {
			...process.env,
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
