#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const vitestCliPath = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const defaultVitestArgs = ["--run", "--maxWorkers=2"];
const sessionControlDbTestPath = "test/session-control-db.test.ts";

function runVitest(args) {
	const result = spawnSync(process.execPath, [vitestCliPath, ...args], {
		cwd: packageRoot,
		env: process.env,
		stdio: "inherit",
	});

	if (result.error) {
		console.error(`Failed to start Vitest: ${result.error.message}`);
		return 1;
	}
	if (result.signal) {
		console.error(`Vitest terminated by signal ${result.signal}`);
		return 1;
	}
	if (result.status === null) {
		console.error("Vitest exited without a status code");
		return 1;
	}
	return result.status;
}

function runAllTests() {
	const mainExitCode = runVitest([...defaultVitestArgs, "--exclude", sessionControlDbTestPath]);
	if (mainExitCode !== 0) return mainExitCode;
	return runVitest(["--run", "--maxWorkers=1", "--fileParallelism=false", sessionControlDbTestPath]);
}

const cliArgs = process.argv.slice(2);
const exitCode = cliArgs.length === 0 ? runAllTests() : runVitest([...defaultVitestArgs, ...cliArgs]);
process.exitCode = exitCode;
