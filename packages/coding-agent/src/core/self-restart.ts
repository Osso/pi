import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Args } from "../cli/args.ts";

export const ENV_SELF_RESTART_SESSION = "PI_SELF_RESTART_SESSION";
export const ENV_SELF_RESTART_PROMPT = "PI_SELF_RESTART_PROMPT";
export const ENV_RESTART_EXIT_CODE = "PI_RESTART_EXIT_CODE";

export interface SelfRestartRequest {
	sessionFile: string;
	prompt?: string;
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
	parsed.messages = env[ENV_SELF_RESTART_PROMPT] ? [env[ENV_SELF_RESTART_PROMPT]] : [];
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
		},
		stdio: "inherit",
	});
	if (dependencies.waitForExit === false) {
		return Promise.resolve(0);
	}
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code: number | null) => {
			resolve(code ?? 0);
		});
	});
}
