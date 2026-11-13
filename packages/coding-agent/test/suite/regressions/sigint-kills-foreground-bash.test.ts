import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

// The foreground Bash tool runs its shell in its own process group, so Ctrl+C in the terminal reaches only
// Pi. Print and RPC mode handled SIGTERM and SIGHUP but not SIGINT, so Pi died and left the command running.

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const modes = [
	{ name: "print", args: ["-p", "run the loop"], stdin: undefined },
	{
		name: "rpc",
		args: ["--mode", "rpc"],
		stdin: `${JSON.stringify({ type: "prompt", id: "p1", message: "run the loop" })}\n`,
	},
] as const;

describe("SIGINT during a foreground Bash tool", () => {
	it.each(modes)(
		"$name mode kills the Bash process tree and exits with 130",
		async ({ args, stdin }) => {
			const paths = createHeadlessPaths();
			const cacheDir = join(paths.tempDir, "compile-cache");
			mkdirSync(cacheDir);
			const pidFile = join(paths.workspaceDir, "shell.pid");
			let child: ChildProcess | undefined;
			let shellPid: number | undefined;
			let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
			await runWithCleanup(
				async () => {
					provider = await createProviderServer(paths.socketPath, (request) => {
						const message = fauxAssistantMessage(
							fauxToolCall("bash", { command: `echo $$ > '${pidFile}'; while true; do sleep 0.05; done` }),
							{ stopReason: "toolUse" },
						);
						provider
							?.getSocket()
							?.write(`${JSON.stringify({ type: "response", requestId: request.id, message })}\n`);
					});
					const cliPath = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
					const preloadPath = join(import.meta.dirname, "..", "fixtures", "headless-pi-provider-preload.ts");
					child = spawn(
						"node",
						[
							"--experimental-strip-types",
							"--import",
							pathToFileURL(preloadPath).href,
							cliPath,
							"--provider",
							"headless-faux",
							"--model",
							"headless-faux-1",
							"--no-session",
							"--no-context-files",
							"--no-skills",
							"--no-themes",
							"--no-extensions",
							...args,
						],
						{
							cwd: paths.workspaceDir,
							env: {
								...process.env,
								NODE_COMPILE_CACHE: cacheDir,
								PI_CODING_AGENT_DIR: paths.agentDir,
								PI_CODING_AGENT_STATE_DIR: paths.agentDir,
								PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
								PI_HEADLESS_PROVIDER_SOCKET: paths.socketPath,
							},
							stdio: ["pipe", "pipe", "pipe"],
						},
					);
					let output = "";
					child.stdout?.on("data", (chunk: Buffer) => {
						output += chunk.toString();
						// RPC mode asks the client to approve the Bash call.
						for (const match of chunk.toString().matchAll(/"type":"extension_ui_request","id":"([^"]+)"/g)) {
							const response = { type: "extension_ui_response", id: match[1], value: "Allow once" };
							child?.stdin?.write(`${JSON.stringify(response)}\n`);
						}
					});
					child.stderr?.on("data", (chunk: Buffer) => {
						output += chunk.toString();
					});
					const closed = new Promise<number | null>((resolve) => child?.once("close", (code) => resolve(code)));
					// Print mode reads piped stdin until EOF; RPC mode keeps it open for commands.
					if (stdin) child.stdin?.write(stdin);
					else child.stdin?.end();

					await vi.waitFor(
						() => {
							if (!existsSync(pidFile)) throw new Error(`Bash did not start. Output: ${output.slice(-2500)}`);
						},
						{ timeout: 20_000, interval: 50 },
					);
					shellPid = Number(readFileSync(pidFile, "utf8").trim());
					expect(isAlive(shellPid)).toBe(true);

					child.kill("SIGINT");

					const exitCode = await closed;
					await vi.waitFor(() => expect(isAlive(shellPid ?? 0)).toBe(false), { timeout: 5_000, interval: 50 });
					expect(exitCode, output.slice(-2000)).toBe(130);
				},
				async () => {
					if (child?.exitCode === null) child.kill("SIGKILL");
					if (shellPid !== undefined && isAlive(shellPid)) process.kill(shellPid, "SIGKILL");
					provider?.getSocket()?.destroy();
					if (provider)
						await new Promise<void>((resolve, reject) =>
							provider?.server.close((error) => (error ? reject(error) : resolve())),
						);
					rmSync(paths.tempDir, { recursive: true, force: true });
				},
			);
		},
		40_000,
	);
});
