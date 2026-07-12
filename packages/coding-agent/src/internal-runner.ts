import { writeFileSync } from "node:fs";
import { DETACHED_PYRUN_RUNNER_MODE, runDetachedPyrunRunner } from "../extensions/pyrun/src/detached-runner.ts";
import { DETACHED_BASH_RUNNER_MODE, runDetachedBashRunner } from "./core/detached-bash-runner.ts";

export async function runInternalDetachedRunner(args: readonly string[]): Promise<boolean> {
	const mode = args[0];
	if (mode !== DETACHED_BASH_RUNNER_MODE && mode !== DETACHED_PYRUN_RUNNER_MODE) return false;
	const manifestPath = args[1];
	if (!manifestPath) throw new Error(`Internal detached runner ${mode} requires a launch manifest path`);
	try {
		if (mode === DETACHED_BASH_RUNNER_MODE) await runDetachedBashRunner(manifestPath);
		else await runDetachedPyrunRunner(manifestPath);
	} catch (error) {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		writeFileSync(`${manifestPath}.runner-error`, `${message}\n`, { encoding: "utf8", mode: 0o600 });
		process.exitCode = 1;
	}
	return true;
}
