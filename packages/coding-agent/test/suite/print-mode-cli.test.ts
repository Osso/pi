import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "./headless-pi.ts";

describe("print-mode CLI", () => {
	it("prints assistant text followed by a terminating end_turn tool result", async () => {
		const paths = createHeadlessPaths();
		const cacheDir = join(paths.tempDir, "compile-cache");
		mkdirSync(cacheDir);
		let child: ChildProcess | undefined;
		let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
		let requests = 0;
		const answer = "answer".repeat(1115);
		await runWithCleanup(
			async () => {
				provider = await createProviderServer(paths.socketPath, (request) => {
					requests++;
					const message = fauxAssistantMessage(
						[{ type: "text", text: answer }, fauxToolCall("end_turn", { reason: "finished" })],
						{ stopReason: "toolUse" },
					);
					provider?.getSocket()?.end(`${JSON.stringify({ type: "response", requestId: request.id, message })}\n`);
				});
				const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
				const preloadPath = join(import.meta.dirname, "fixtures", "headless-pi-provider-preload.ts");
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
						"-p",
						"question",
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
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				let stdout = "";
				let stderr = "";
				child.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				const exitCode = await new Promise<number | null>((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error(`CLI timeout: requests=${requests}, stdout=${stdout}, stderr=${stderr}`)),
						10_000,
					);
					child?.once("error", (error) => {
						clearTimeout(timer);
						reject(error);
					});
					child?.once("close", (code) => {
						clearTimeout(timer);
						resolve(code);
					});
				});
				expect(exitCode, stderr).toBe(0);
				expect(requests).toBe(1);
				expect(stdout).toBe(`${answer}\n`);
			},
			async () => {
				if (child?.exitCode === null) child.kill("SIGKILL");
				provider?.getSocket()?.destroy();
				if (provider)
					await new Promise<void>((resolve, reject) =>
						provider?.server.close((error) => (error ? reject(error) : resolve())),
					);
				rmSync(paths.tempDir, { recursive: true, force: true });
			},
		);
	}, 30_000);
});
