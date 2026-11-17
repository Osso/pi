import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createHeadlessPaths } from "../headless-pi.ts";

const MATCHED = "headless-faux/headless-faux-1";
const UNMATCHED = "github-copilot/missing-model";

/**
 * Starts RPC mode with `startModels` as enabledModels, then sends one new_session per entry of `replacements`,
 * writing that entry's enabledModels first. Returns everything the process wrote to stdout and stderr.
 */
async function runNewSessionsOverRpc(
	startModels: string[],
	replacements: string[][],
): Promise<{ stdout: string; stderr: string }> {
	const paths = createHeadlessPaths();
	const writeSettings = (enabledModels: string[]) =>
		writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify({ enabledModels }));
	try {
		writeSettings(startModels);
		const cliPath = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
		const preloadPath = join(import.meta.dirname, "..", "fixtures", "headless-pi-provider-preload.ts");
		const child = spawn(
			"node",
			[
				"--experimental-strip-types",
				"--import",
				pathToFileURL(preloadPath).href,
				cliPath,
				...["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-context-files"],
			],
			{
				cwd: paths.workspaceDir,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: paths.agentDir,
					PI_CODING_AGENT_STATE_DIR: paths.agentDir,
					PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
					PI_HEADLESS_PROVIDER_SOCKET: paths.socketPath,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		const responses = () => stdout.split('"command":"new_session"').length - 1;
		try {
			for (const [index, enabledModels] of replacements.entries()) {
				writeSettings(enabledModels);
				await new Promise<void>((resolve, reject) => {
					const onData = () => {
						if (responses() <= index) return;
						child.stdout.off("data", onData);
						resolve();
					};
					child.stdout.on("data", onData);
					child.once("close", () => reject(new Error(`RPC process exited early. stderr:\n${stderr}`)));
					child.stdin.write(`${JSON.stringify({ id: String(index + 1), type: "new_session" })}\n`);
				});
			}
			child.stdin.end();
			await closed;
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
		}
		return { stdout, stderr };
	} finally {
		rmSync(paths.tempDir, { recursive: true, force: true });
	}
}

// Upstream #11973: the runtime factory runs again on /new, /resume and /fork. It printed model scope warnings
// with console.warn, which drew over the interactive TUI. They are now startup diagnostics, reported once.
describe("model scope warnings on session replacement", () => {
	it("reports an unmatched enabledModels pattern once at startup, not again on new_session", async () => {
		const { stderr } = await runNewSessionsOverRpc([MATCHED, UNMATCHED], [[MATCHED, UNMATCHED]]);
		expect(stderr.match(/No models match pattern "github-copilot\/missing-model"/g)).toHaveLength(1);
	}, 60_000);

	// Upstream #12115: diagnostics that first appear on a replacement were collected and then discarded.
	it("reports a pattern that first fails on new_session once, on stderr", async () => {
		const { stdout, stderr } = await runNewSessionsOverRpc(
			[MATCHED],
			[[MATCHED], [MATCHED, UNMATCHED], [MATCHED, UNMATCHED]],
		);
		expect(stderr.match(/Warning: No models match pattern "github-copilot\/missing-model"/g)).toHaveLength(1);
		expect(stdout).not.toContain("No models match pattern");
	}, 60_000);
});
