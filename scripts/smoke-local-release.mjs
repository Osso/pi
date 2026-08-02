#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function printUsage() {
	console.error("Usage: node scripts/smoke-local-release.mjs <pi-path>");
}

const piPath = process.argv[2];
if (!piPath || process.argv.length !== 3) {
	printUsage();
	process.exit(2);
}

const agentDir = mkdtempSync(join(tmpdir(), "pi-local-release-smoke-"));
const commands = [["--help"], ["--version"], ["--list-models"]];

try {
	const resolvedPiPath = resolve(piPath);
	const environment = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
	for (const args of commands) {
		const result = spawnSync(resolvedPiPath, args, {
			encoding: "utf8",
			env: environment,
			shell: process.platform === "win32",
		});
		if (result.status !== 0) {
			process.stderr.write(result.stdout ?? "");
			process.stderr.write(result.stderr ?? "");
			throw new Error(`${piPath} ${args.join(" ")} exited ${result.status ?? "without status"}`);
		}
	}

	const manifestPath = join(agentDir, "invalid-pyrun-launch.json");
	const runnerErrorPath = `${manifestPath}.runner-error`;
	writeFileSync(manifestPath, "{}\n");
	const runnerResult = spawnSync(resolvedPiPath, ["--internal-detached-pyrun-runner", manifestPath], {
		encoding: "utf8",
		env: environment,
		shell: process.platform === "win32",
	});
	const runnerError = existsSync(runnerErrorPath) ? readFileSync(runnerErrorPath, "utf8") : "";
	if (runnerResult.status !== 1 || !runnerError.includes("Invalid detached Pyrun launch manifest")) {
		process.stderr.write(runnerResult.stdout ?? "");
		process.stderr.write(runnerResult.stderr ?? "");
		throw new Error(`${piPath} did not execute the packaged detached Pyrun runner`);
	}
} finally {
	rmSync(agentDir, { force: true, recursive: true });
}
