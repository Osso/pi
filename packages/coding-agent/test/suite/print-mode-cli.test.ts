import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "./headless-pi.ts";

interface PrintModeRun {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	requestMessages: Message[][];
}

async function runPrintMode(answer: string, cliArgs: string[], stdin?: string): Promise<PrintModeRun> {
	const paths = createHeadlessPaths();
	const cacheDir = join(paths.tempDir, "compile-cache");
	mkdirSync(cacheDir);
	let child: ChildProcess | undefined;
	let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
	const requestMessages: Message[][] = [];
	let result: PrintModeRun | undefined;
	await runWithCleanup(
		async () => {
			provider = await createProviderServer(paths.socketPath, (request) => {
				requestMessages.push(request.messages);
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
					...cliArgs,
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
					stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
				},
			);
			if (stdin !== undefined) child.stdin?.end(stdin);
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
					() =>
						reject(
							new Error(`CLI timeout: requests=${requestMessages.length}, stdout=${stdout}, stderr=${stderr}`),
						),
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
			result = { exitCode, stdout, stderr, requestMessages };
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
	if (!result) throw new Error("print-mode run produced no result");
	return result;
}

describe("print-mode CLI", () => {
	it("prints assistant text followed by a terminating end_turn tool result", async () => {
		const answer = "answer".repeat(1115);
		const run = await runPrintMode(answer, ["-p", "question"]);
		expect(run.exitCode, run.stderr).toBe(0);
		expect(run.requestMessages).toHaveLength(1);
		expect(run.stdout).toBe(`${answer}\n`);
	}, 30_000);

	it("separates piped stdin from the -p message", async () => {
		const run = await runPrintMode("ok", ["-p", "explain"], "fix this error\n");
		expect(run.exitCode, run.stderr).toBe(0);
		const firstUser = run.requestMessages[0]?.find((message) => message.role === "user");
		const text =
			typeof firstUser?.content === "string"
				? firstUser.content
				: firstUser?.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		expect(text).toBe("fix this error\nexplain");
	}, 30_000);

	it("exits with an error instead of hanging when an @ argument is a directory", async () => {
		const run = await runPrintMode("unused", ["-p", "@.", "hi"]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toMatch(/is a directory; @ arguments must be files/);
		expect(run.requestMessages).toEqual([]);
	}, 30_000);
});
