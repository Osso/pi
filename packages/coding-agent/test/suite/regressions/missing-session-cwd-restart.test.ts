import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { type HeadlessPiPaths, withHeadlessPi } from "../headless-pi.ts";

function startRestartedPi(paths: HeadlessPiPaths, sessionFile: string): ChildProcessWithoutNullStreams {
	const cliPath = join(import.meta.dirname, "../../../src/cli.ts");
	const providerPreload = join(import.meta.dirname, "../fixtures/headless-pi-provider-preload.ts");
	const ttyPreload = join(import.meta.dirname, "../fixtures/headless-pi-tty-preload.mjs");
	const restartPreload = join(import.meta.dirname, "../fixtures/delete-cwd-self-restart-preload.mjs");
	return spawn(
		process.execPath,
		[
			"--import",
			import.meta.resolve("tsx"),
			"--import",
			pathToFileURL(providerPreload).href,
			"--import",
			pathToFileURL(ttyPreload).href,
			"--import",
			pathToFileURL(restartPreload).href,
			cliPath,
			"--approve",
			"--no-context-files",
			"--no-skills",
			"--no-themes",
			"--provider",
			"headless-faux",
			"--model",
			"headless-faux-1",
		],
		{
			cwd: paths.workspaceDir,
			env: {
				...process.env,
				NO_COLOR: "1",
				PI_CODING_AGENT_DIR: paths.agentDir,
				PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
				PI_CODING_AGENT_STATE_DIR: paths.agentDir,
				PI_HEADLESS_PROVIDER_SOCKET: join(paths.tempDir, "provider.sock"),
				PI_TEST_RESTART_SESSION: sessionFile,
				TERM: "xterm-256color",
			},
		},
	);
}

async function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string): Promise<string> {
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (output.includes(expected)) return output;
		if (child.exitCode !== null) throw new Error(`Pi exited before rendering ${expected}:\n${output}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${expected}:\n${output}`);
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGTERM");
	await exited;
}

it("offers an existing parent cwd when self-restarting after its cwd was deleted", async () => {
	await withHeadlessPi(async (agent) => {
		await agent.crash();
		const deletedCwd = agent.paths.workspaceDir;
		const fallbackCwd = dirname(deletedCwd);
		const child = startRestartedPi(agent.paths, agent.sessionFile);
		try {
			const output = await waitForOutput(child, fallbackCwd);
			const renderedLines = stripAnsi(output)
				.split("\n")
				.map((line) => line.trim());
			expect(existsSync(deletedCwd)).toBe(false);
			expect(renderedLines).toContain("cwd from session file does not exist");
			expect(renderedLines).toContain("continue in current cwd");
			expect(renderedLines).toContain(fallbackCwd);
		} finally {
			await stopProcess(child);
		}
	});
}, 30_000);
