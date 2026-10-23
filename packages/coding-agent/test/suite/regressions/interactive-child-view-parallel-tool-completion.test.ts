import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

const TIMEOUT_MS = 30_000;
const SLOW_SECONDS = 8;
// Built from split quotes so the rendered command text never contains the result marker.
const FAST_COMMAND = "printf 'FAST''RESULT'";
const SLOW_COMMAND = `sleep ${SLOW_SECONDS}; printf 'SLOW''RESULT'`;

type WireRequest = { id: string; sessionId?: string };

async function waitUntil(predicate: () => boolean, description: string, output: () => string): Promise<void> {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}; output: ${output().slice(-3000)}`);
}

async function stopBridge(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.kill("SIGTERM");
	await exited;
}

// Requires python3 and a Unix PTY; skip Windows only.
it.skipIf(process.platform === "win32")(
	"child view shows a finished tool result while its parallel sibling is still running",
	async () => {
		const paths = createHeadlessPaths();
		const cacheDir = join(paths.tempDir, "compile-cache");
		mkdirSync(cacheDir);
		writeFileSync(
			join(paths.agentDir, "settings.json"),
			JSON.stringify({ approvalPolicy: "auto-approve", approvalPreset: "auto-approve" }),
		);
		let mainSessionId: string | undefined;
		let childRequests = 0;
		let batchSentAt: number | undefined;
		let bridge: ChildProcessWithoutNullStreams | undefined;
		let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
		let output = "";
		const log = () => output;

		let mainRequests = 0;
		// The first main request spawns the child; later main requests stay unanswered so the main turn keeps running.
		const respondTo = (request: WireRequest): AssistantMessage | undefined => {
			mainSessionId ??= request.sessionId;
			if (request.sessionId === mainSessionId) {
				if (++mainRequests > 1) return undefined;
				return fauxAssistantMessage(
					fauxToolCall("spawn_agent", {
						context: "fresh",
						displayName: "Batch child",
						prompt: "Run both commands",
					}),
					{ stopReason: "toolUse" },
				);
			}
			childRequests++;
			if (childRequests === 1) {
				batchSentAt = Date.now();
				return fauxAssistantMessage(
					[fauxToolCall("bash", { command: SLOW_COMMAND }), fauxToolCall("bash", { command: FAST_COMMAND })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Done" }), { stopReason: "toolUse" });
		};

		await runWithCleanup(
			async () => {
				provider = await createProviderServer(paths.socketPath, (request) => {
					const wire = request as WireRequest;
					const message = respondTo(wire);
					if (!message) return;
					provider?.getSocket()?.write(`${JSON.stringify({ type: "response", requestId: wire.id, message })}\n`);
				});
				const cliPath = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
				const preloadPath = join(import.meta.dirname, "..", "fixtures", "interactive-pty-provider-preload.ts");
				const extensionPath = join(import.meta.dirname, "..", "fixtures", "interactive-pty-provider-extension.ts");
				const bridgePath = join(import.meta.dirname, "..", "fixtures", "interactive-pty-bridge.py");
				bridge = spawn(
					"python3",
					[
						bridgePath,
						"40",
						"120",
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
						"--extension",
						extensionPath,
						"Delegate the batch",
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
							NO_COLOR: "1",
							TERM: "xterm-256color",
						},
					},
				);
				bridge.stdout.setEncoding("utf8");
				bridge.stdout.on("data", (text: string) => {
					output += text;
				});
				bridge.stderr.on("data", (chunk: Buffer) => {
					output += chunk.toString();
				});

				await waitUntil(() => batchSentAt !== undefined, "child batch request", log);
				// Open the child agent view (active agent slot 1).
				bridge.stdin.write("\x1b2");
				await waitUntil(() => output.includes("FASTRESULT"), "fast result in the child view", log);

				expect(Date.now() - (batchSentAt ?? 0)).toBeLessThan((SLOW_SECONDS - 2) * 1_000);
				expect(output).not.toContain("SLOWRESULT");
			},
			async () => {
				await stopBridge(bridge);
				provider?.getSocket()?.destroy();
				if (provider)
					await new Promise<void>((resolve, reject) =>
						provider?.server.close((error) => (error ? reject(error) : resolve())),
					);
				rmSync(paths.tempDir, { recursive: true, force: true });
			},
		);
	},
	60_000,
);
