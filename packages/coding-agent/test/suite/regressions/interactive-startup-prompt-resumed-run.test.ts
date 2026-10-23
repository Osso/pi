import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

const TIMEOUT_MS = 20_000;
const INTERRUPTED_TASK = "Interrupted task that keeps working";
const STARTUP_PROMPT = "Startup prompt sent while the resumed run is busy";

type WireRequest = { id: string; messages: Array<{ role: string; content: unknown }> };

async function waitUntil(predicate: () => boolean, description: string, output: () => string): Promise<void> {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}; output: ${output().slice(-3000)}`);
}

function userTexts(request: WireRequest): string[] {
	return request.messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		if (!Array.isArray(message.content)) return [];
		return message.content.flatMap((block: { type?: string; text?: string }) =>
			block.type === "text" && block.text ? [block.text] : [],
		);
	});
}

function findSessionFile(sessionDir: string): string {
	const files = readdirSync(sessionDir, { recursive: true }).filter(
		(path): path is string => typeof path === "string" && path.endsWith(".jsonl"),
	);
	if (files.length !== 1) throw new Error(`expected one session transcript, found ${files.length}`);
	return join(sessionDir, files[0]);
}

async function stopBridge(child: ChildProcessWithoutNullStreams | undefined, signal: NodeJS.Signals): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.kill(signal);
	await exited;
}

// Requires python3 and a Unix PTY; skip Windows only.
it.skipIf(process.platform === "win32")(
	"steers a startup prompt into a resumed interrupted run instead of waiting for it to go idle",
	async () => {
		const paths = createHeadlessPaths();
		const cacheDir = join(paths.tempDir, "compile-cache");
		mkdirSync(cacheDir);
		writeFileSync(
			join(paths.agentDir, "settings.json"),
			JSON.stringify({ approvalPolicy: "auto-approve", approvalPreset: "auto-approve" }),
		);
		const requests: WireRequest[] = [];
		let respond: (request: WireRequest) => AssistantMessage | undefined = () => undefined;
		let bridge: ChildProcessWithoutNullStreams | undefined;
		let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
		let output = "";
		const startPi = (args: string[]): ChildProcessWithoutNullStreams => {
			const cliPath = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
			const preloadPath = join(import.meta.dirname, "..", "fixtures", "interactive-pty-provider-preload.ts");
			const extensionPath = join(import.meta.dirname, "..", "fixtures", "interactive-pty-provider-extension.ts");
			const bridgePath = join(import.meta.dirname, "..", "fixtures", "interactive-pty-bridge.py");
			const child = spawn(
				"python3",
				[
					bridgePath,
					"24",
					"100",
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
						NO_COLOR: "1",
						TERM: "xterm-256color",
					},
				},
			);
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (text: string) => {
				output += text;
			});
			child.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			return child;
		};
		const log = () => `${output}\nrequests=${JSON.stringify(requests.map(userTexts))}`;

		await runWithCleanup(
			async () => {
				provider = await createProviderServer(paths.socketPath, (request) => {
					const wire = request as WireRequest;
					requests.push(wire);
					const message = respond(wire);
					if (message) {
						provider
							?.getSocket()
							?.write(`${JSON.stringify({ type: "response", requestId: wire.id, message })}\n`);
					}
				});

				// First process: the task runs one tool, then dies while its next model request is in flight.
				respond = (request) =>
					requests.indexOf(request) === 0
						? fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" })
						: undefined;
				bridge = startPi([INTERRUPTED_TASK]);
				await waitUntil(() => requests.length === 2, "in-flight request after the first tool", log);
				await stopBridge(bridge, "SIGKILL");
				const sessionFile = findSessionFile(paths.sessionDir);

				// Second process: resuming continues the interrupted task, which keeps working through a
				// tool call. The startup prompt must reach that run before it goes idle.
				respond = (request) => {
					if (requests.indexOf(request) === 2)
						return fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" });
					return fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Done" }), { stopReason: "toolUse" });
				};
				bridge = startPi(["--session", sessionFile, STARTUP_PROMPT]);
				await waitUntil(() => requests.length >= 4, "request after the resumed tool call", log);

				// Requests 2 and 3 belong to the resumed run (it only ends with end_turn after request 3).
				expect(userTexts(requests[2])).toContain(INTERRUPTED_TASK);
				expect([...userTexts(requests[2]), ...userTexts(requests[3])], log()).toContain(STARTUP_PROMPT);
				expect(output).not.toContain("already processing");
			},
			async () => {
				await stopBridge(bridge, "SIGTERM");
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
