import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type AssistantMessage, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

const GPU_ANSWER = "GPU answer: use the graphics processor for parallel rendering.";
const DEPOT_ANSWER =
	"**Yes, but not through the standard builders we’re using.**\n\nDepot offers GPU-backed GitHub Actions runners through **Depot Managed**, running in **your own AWS account**. Setup requires contacting Depot for GPU instance selection, drivers, and a custom runner label. ([Official docs](https://depot.dev/docs/managed/using-gpus))\n\nUseful for remote rendering or GPU tests—not accelerating our Rust compilation. Our current `local-builds` setup is CPU-only.";
const FINAL_ANSWER_SIGNATURE = JSON.stringify({ v: 1, id: "test-final", phase: "final_answer" });
const TIMEOUT_MS = 15_000;

async function waitUntil(predicate: () => boolean, description: string, output: () => string): Promise<void> {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}; PTY output: ${output().slice(-4000)}`);
}

function readSessionMessages(sessionDir: string): Array<{ role?: string; content?: unknown; toolName?: string }> {
	return readdirSync(sessionDir, { recursive: true })
		.filter((path): path is string => typeof path === "string" && path.endsWith(".jsonl"))
		.flatMap((path) => readFileSync(join(sessionDir, path), "utf8").trim().split("\n"))
		.map(
			(line) =>
				JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown; toolName?: string } },
		)
		.flatMap((entry) => (entry.type === "message" && entry.message ? [entry.message] : []));
}

function hasAssistantText(message: { role?: string; content?: unknown }, text: string): boolean {
	return (
		message.role === "assistant" &&
		Array.isArray(message.content) &&
		message.content.some(
			(block: unknown) => block !== null && typeof block === "object" && "text" in block && block.text === text,
		)
	);
}

function expectDepotAnswerInScrollback(screen: string, output: string): void {
	for (const excerpt of [
		"Yes, but not through the standard builders",
		"Depot offers GPU-backed GitHub Actions runners",
		"Depot Managed",
		"your own AWS account",
		"custom runner label",
		"Official docs",
		"Useful for remote rendering or GPU tests",
		"local-builds",
		"CPU-only",
	])
		expect(screen, output).toContain(excerpt);
}

function responseForRequest(request: number, rows: number, answer: string, ghostty: boolean): AssistantMessage {
	if (rows === 12 && request === 1) {
		return fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" });
	}
	if (request === (rows === 12 ? 2 : 1)) {
		const content = ghostty ? { type: "text" as const, text: answer, textSignature: FINAL_ANSWER_SIGNATURE } : answer;
		return fauxAssistantMessage(content);
	}
	const content = ghostty
		? [fauxThinking("Checking completion."), fauxToolCall("end_turn", { reason: "Done" })]
		: fauxToolCall("end_turn", { reason: "Done" });
	return fauxAssistantMessage(content, { stopReason: "toolUse" });
}

async function stopBridge(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.kill("SIGTERM");
	const stopped = await Promise.race([
		exited.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_500)),
	]);
	if (!stopped) {
		child.kill("SIGKILL");
		await exited;
	}
}

// Requires python3 and a Unix PTY; skip Windows only.
it.skipIf(process.platform === "win32").each([
	{ name: "standard terminal", rows: 24, answer: GPU_ANSWER },
	{
		name: "small terminal overflow",
		rows: 12,
		answer: `${GPU_ANSWER}\n${"GPU detail line for overflow.\n".repeat(18)}GPU answer tail.`,
	},
	{ name: "Ghostty final answer and notifications", rows: 12, answer: DEPOT_ANSWER },
])(
	"retains persisted answer in actual CLI PTY scrollback after end_turn and redraw ($name)",
	async ({ rows, answer, name }) => {
		const ghostty = name === "Ghostty final answer and notifications";
		const paths = createHeadlessPaths();
		const cacheDir = join(paths.tempDir, "compile-cache");
		mkdirSync(cacheDir);
		writeFileSync(
			join(paths.agentDir, "settings.json"),
			JSON.stringify({ approvalPolicy: "auto-approve", approvalPreset: "auto-approve" }),
		);
		const terminal = new VirtualTerminal(80, rows);
		let bridge: ChildProcessWithoutNullStreams | undefined;
		let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
		let requests = 0;
		let rawOutput = "";
		let stderr = "";
		await runWithCleanup(
			async () => {
				provider = await createProviderServer(paths.socketPath, (request) => {
					requests++;
					const message = responseForRequest(requests, rows, answer, ghostty);
					provider
						?.getSocket()
						?.write(`${JSON.stringify({ type: "response", requestId: request.id, message })}\n`);
				});
				const cliPath = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
				const preloadPath = join(import.meta.dirname, "..", "fixtures", "interactive-pty-provider-preload.ts");
				const extensionPath = join(import.meta.dirname, "..", "fixtures", "interactive-pty-provider-extension.ts");
				const bridgePath = join(import.meta.dirname, "..", "fixtures", "interactive-pty-bridge.py");
				bridge = spawn(
					"python3",
					[
						bridgePath,
						String(rows),
						"80",
						process.execPath,
						"--experimental-strip-types",
						"--import",
						pathToFileURL(preloadPath).href,
						cliPath,
						"--provider",
						"headless-faux",
						"--model",
						"headless-faux-1",
						"--session-dir",
						paths.sessionDir,
						"--no-context-files",
						"--no-skills",
						"--no-themes",
						"--no-extensions",
						"--extension",
						extensionPath,
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
							TERM: ghostty ? "xterm-ghostty" : "xterm-256color",
							TERM_PROGRAM: ghostty ? "ghostty" : process.env.TERM_PROGRAM,
							NO_COLOR: ghostty ? undefined : "1",
							PI_TEST_PTY_NOTIFICATIONS: ghostty ? "1" : undefined,
						},
					},
				);
				bridge.stdout.setEncoding("utf8");
				bridge.stdout.on("data", (text: string) => {
					rawOutput += text;
					terminal.write(text);
				});
				bridge.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				const output = () => `${rawOutput.slice(-4000)}\n${stderr}`;
				await waitUntil(() => rawOutput.includes("headless-faux-1"), "interactive editor", output);
				bridge.stdin.write("Answer the GPU question");
				await waitUntil(() => rawOutput.includes("Answer the GPU question"), "question in editor", output);
				bridge.stdin.write("\r");
				await waitUntil(
					() => requests >= (rows === 12 ? 3 : 2),
					`terminating faux-provider request (received ${requests})`,
					() => `${output()}\nrequests=${requests}\nviewport=${terminal.getViewport().join(" | ")}`,
				);
				await waitUntil(
					() => {
						const messages = readSessionMessages(paths.sessionDir);
						return messages.some((message) => message.role === "toolResult" && message.toolName === "end_turn");
					},
					"persisted end_turn tool result",
					output,
				);
				const messages = readSessionMessages(paths.sessionDir);
				expect(messages.some((message) => hasAssistantText(message, answer))).toBe(true);
				if (ghostty) {
					const finalAnswer = messages.find((message) => hasAssistantText(message, DEPOT_ANSWER));
					expect(finalAnswer?.content).toEqual([
						{ type: "text", text: DEPOT_ANSWER, textSignature: FINAL_ANSWER_SIGNATURE },
					]);
					const toolResultIndex = messages.findIndex(
						(message) => message.role === "toolResult" && message.toolName === "ls",
					);
					const answerIndex = messages.indexOf(finalAnswer ?? {});
					const endTurnIndex = messages.findIndex(
						(message) =>
							message.role === "assistant" &&
							Array.isArray(message.content) &&
							message.content.some(
								(block: unknown) =>
									block !== null && typeof block === "object" && "type" in block && block.type === "thinking",
							) &&
							message.content.some(
								(block: unknown) =>
									block !== null && typeof block === "object" && "name" in block && block.name === "end_turn",
							) &&
							!message.content.some(
								(block: unknown) =>
									block !== null && typeof block === "object" && "type" in block && block.type === "text",
							),
					);
					expect(toolResultIndex).toBeGreaterThan(0);
					expect(answerIndex).toBeGreaterThan(toolResultIndex);
					expect(endTurnIndex).toBeGreaterThan(answerIndex);
				}
				if (rows === 12) {
					if (!ghostty) expect(JSON.stringify(messages)).toContain("GPU answer tail.");
					expect(messages.some((message) => message.role === "toolResult" && message.toolName === "ls")).toBe(
						true,
					);
				}
				expect(requests).toBe(rows === 12 ? 3 : 2);
				await new Promise((resolve) => setTimeout(resolve, 100));
				await terminal.flush();
				const screen = () => terminal.getScrollBuffer().join("\n");
				if (ghostty) {
					expectDepotAnswerInScrollback(screen(), output());
				} else {
					expect(screen(), output()).toContain(GPU_ANSWER);
				}

				// Open and close a real interactive overlay to force another full TUI paint.
				bridge.stdin.write("\x0c"); // Ctrl+L: model selector.
				await waitUntil(
					() => terminal.getViewport().join("\n").includes("Only showing models from configured providers"),
					"model selector paint",
					output,
				);
				bridge.stdin.write("\x1b");
				await waitUntil(
					() => !terminal.getViewport().join("\n").includes("Only showing models from configured providers"),
					"model selector close",
					output,
				);
				await new Promise((resolve) => setTimeout(resolve, 100));
				await terminal.flush();
				if (ghostty) {
					expectDepotAnswerInScrollback(screen(), output());
					expect(screen(), output()).toContain("PTY notification 6");
				} else {
					expect(screen(), output()).toContain(GPU_ANSWER);
				}
			},
			async () => {
				if (bridge) await stopBridge(bridge);
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
