import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const cliEntry = join(repoRoot, "packages/coding-agent/src/cli.ts");
const tsxEntry = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
const temporaryDirectories: string[] = [];

function createTemporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function writeAvailableCommand(directory: string, name: string): string {
	const executableName = process.platform === "win32" ? `${name}.CMD` : name;
	const path = join(directory, executableName);
	writeFileSync(path, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
	if (process.platform !== "win32") chmodSync(path, 0o755);
	return path;
}

function listFirstPartyExtensions(environment: NodeJS.ProcessEnv): string {
	const runtimeRoot = createTemporaryDirectory("pi-first-party-extension-inventory-");
	const agentDir = join(runtimeRoot, "agent");
	const stateDir = join(runtimeRoot, "state");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	const result = spawnSync(
		process.execPath,
		[
			tsxEntry,
			"--tsconfig",
			join(repoRoot, "tsconfig.json"),
			cliEntry,
			"extensions",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-approve",
		],
		{
			cwd: runtimeRoot,
			encoding: "utf8",
			env: {
				...process.env,
				...environment,
				PI_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_STATE_DIR: stateDir,
			},
			timeout: 30_000,
		},
	);
	if (result.status !== 0) {
		throw new Error(`pi extensions failed (${result.status}): ${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("first-party extension executable availability", () => {
	it("omits unavailable binary-backed extensions from startup inventory", () => {
		const emptyPath = createTemporaryDirectory("pi-first-party-empty-path-");
		const output = listFirstPartyExtensions({
			PATH: emptyPath,
			PI_CLAUDE_BASH_HOOK: join(emptyPath, "missing-claude-bash-hook"),
			PI_PYRUN_RUNNER_COMMAND: join(emptyPath, "missing-pyrun-jsonl"),
		});

		expect(output).not.toMatch(/built-in\s+browser-cli\s/);
		expect(output).not.toMatch(/built-in\s+claude-bash-hook\s/);
		expect(output).not.toMatch(/built-in\s+pyrun\s/);
		expect(output).not.toMatch(/built-in\s+openai-remote-compact\s/);
		expect(output).toMatch(/built-in\s+goal\s/);
	});

	it("loads binary-backed extensions when their executables are available", () => {
		const binDirectory = createTemporaryDirectory("pi-first-party-bin-");
		writeAvailableCommand(binDirectory, "browser-cli");
		const hookPath = writeAvailableCommand(binDirectory, "claude-bash-hook");
		const output = listFirstPartyExtensions({
			PATH: [binDirectory, process.env.PATH].filter(Boolean).join(delimiter),
			PI_CLAUDE_BASH_HOOK: hookPath,
			PI_PYRUN_RUNNER_COMMAND: process.execPath,
		});

		expect(output).toMatch(/built-in\s+browser-cli\s/);
		expect(output).toMatch(/built-in\s+claude-bash-hook\s/);
		expect(output).toMatch(/built-in\s+pyrun\s/);
	});
});
