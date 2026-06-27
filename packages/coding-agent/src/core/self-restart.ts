import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Args } from "../cli/args.ts";

export const ENV_SELF_RESTART_SESSION = "PI_SELF_RESTART_SESSION";
export const ENV_SELF_RESTART_PROMPT = "PI_SELF_RESTART_PROMPT";

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
