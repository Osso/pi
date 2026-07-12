import { writeFileSync } from "node:fs";
import { runDetachedPyrunRunner } from "./detached-runner.ts";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Detached Pyrun runner requires a launch manifest path");

try {
	await runDetachedPyrunRunner(manifestPath);
} catch (error) {
	const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(`${manifestPath}.runner-error`, `${message}\n`, { encoding: "utf8", mode: 0o600 });
	process.exitCode = 1;
}
