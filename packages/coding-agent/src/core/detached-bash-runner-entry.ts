import { writeFileSync } from "node:fs";
import { runDetachedBashRunner } from "./detached-bash-runner.ts";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Detached Bash runner requires a launch manifest path");

try {
	await runDetachedBashRunner(manifestPath);
} catch (error) {
	const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(`${manifestPath}.runner-error`, `${message}\n`, { encoding: "utf8", mode: 0o600 });
	process.exitCode = 1;
}
