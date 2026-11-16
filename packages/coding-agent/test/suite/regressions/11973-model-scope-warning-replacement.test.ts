import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createHeadlessPaths } from "../headless-pi.ts";

/** Starts RPC mode, replaces the session once, and returns everything the process wrote to stderr. */
async function runNewSessionOverRpc(): Promise<string> {
	const paths = createHeadlessPaths();
	try {
		writeFileSync(
			join(paths.agentDir, "settings.json"),
			JSON.stringify({ enabledModels: ["headless-faux/headless-faux-1", "github-copilot/missing-model"] }),
		);
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
		try {
			await new Promise<void>((resolve, reject) => {
				child.stdout.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
					if (stdout.includes('"command":"new_session"')) resolve();
				});
				child.once("close", () => reject(new Error(`RPC process exited early. stderr:\n${stderr}`)));
				child.stdin.write(`${JSON.stringify({ id: "1", type: "new_session" })}\n`);
			});
			child.stdin.end();
			await closed;
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
		}
		return stderr;
	} finally {
		rmSync(paths.tempDir, { recursive: true, force: true });
	}
}

// Upstream #11973: the runtime factory runs again on /new, /resume and /fork. It printed model scope warnings
// with console.warn, which drew over the interactive TUI. They are now startup diagnostics, reported once.
describe("model scope warnings on session replacement", () => {
	it("reports an unmatched enabledModels pattern once at startup, not again on new_session", async () => {
		const stderr = await runNewSessionOverRpc();
		expect(stderr.match(/No models match pattern "github-copilot\/missing-model"/g)).toHaveLength(1);
	}, 60_000);
});
