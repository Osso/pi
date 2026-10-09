import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

const UNKNOWN_INPUT = "/not-a-command keep these arguments";
const FEEDBACK = "Error: Unknown slash command: /not-a-command";

type ProviderRequest = { id: string; messages: Message[] };

function userTexts(request: ProviderRequest): string[] {
	return request.messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return [
			message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		];
	});
}

async function waitUntil(predicate: () => boolean, description: string, output: () => string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}; ${output()}`);
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

it.skipIf(process.platform === "win32").each([
	{ name: "idle Enter", streaming: false, key: "\r" },
	{ name: "idle Alt+Enter", streaming: false, key: "\x1b\r" },
	{ name: "streaming Enter", streaming: true, key: "\r" },
	{ name: "streaming Alt+Enter", streaming: true, key: "\x1b\r" },
])(
	"rejects unknown slash input inside the live TUI ($name)",
	async ({ streaming, key }) => {
		const paths = createHeadlessPaths();
		const terminal = new VirtualTerminal(100, 24);
		const requests: ProviderRequest[] = [];
		let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
		let bridge: ChildProcessWithoutNullStreams | undefined;
		let rawOutput = "";
		let stderr = "";
		const output = () => `${rawOutput.slice(-4000)}\n${stderr}`;
		const screen = () => terminal.getViewport().join("\n");
		const sessionEntries = () => {
			const file = readdirSync(paths.sessionDir, { recursive: true }).find(
				(entry) => typeof entry === "string" && entry.endsWith(".jsonl"),
			);
			return typeof file === "string" ? SessionManager.open(join(paths.sessionDir, file)).getEntries() : [];
		};
		const completedTurns = () =>
			sessionEntries().filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn",
			).length;
		const respond = (request: ProviderRequest) => {
			provider?.getSocket()?.write(
				`${JSON.stringify({
					type: "response",
					requestId: request.id,
					message: fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Test complete" }), {
						stopReason: "toolUse",
					}),
				})}\n`,
			);
		};

		await runWithCleanup(
			async () => {
				mkdirSync(join(paths.agentDir, "prompts"));
				writeFileSync(join(paths.agentDir, "prompts", "example.md"), "Expanded template: $ARGUMENTS");
				writeFileSync(
					join(paths.agentDir, "settings.json"),
					JSON.stringify({ approvalPreset: "auto-approve", approvalPolicy: "auto-approve", quietStartup: true }),
				);
				provider = await createProviderServer(paths.socketPath, (request) => {
					requests.push(request);
					// Keep a real provider request open while testing the streaming rejection boundary.
					if (streaming && requests.length === 1) return;
					respond(request);
				});
				const fixtureDir = join(import.meta.dirname, "..", "fixtures");
				bridge = spawn(
					"python3",
					[
						join(fixtureDir, "interactive-pty-bridge.py"),
						"24",
						"100",
						process.execPath,
						"--experimental-strip-types",
						"--import",
						pathToFileURL(join(fixtureDir, "interactive-pty-provider-preload.ts")).href,
						join(import.meta.dirname, "..", "..", "..", "src", "cli.ts"),
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
						join(fixtureDir, "interactive-pty-provider-extension.ts"),
					],
					{
						cwd: paths.workspaceDir,
						env: {
							...process.env,
							PI_OFFLINE: "1",
							PI_TELEMETRY: "0",
							PI_CODING_AGENT_DIR: paths.agentDir,
							PI_CODING_AGENT_STATE_DIR: paths.agentDir,
							PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
							PI_HEADLESS_PROVIDER_SOCKET: paths.socketPath,
							PI_TUI_WRITE_LOG: "",
							PI_DEBUG_REDRAW: "0",
							PI_TUI_DEBUG: "0",
							TERM: "xterm-256color",
							NO_COLOR: "1",
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
				await waitUntil(() => screen().includes("headless-faux-1"), "interactive startup", output);
				if (streaming) {
					bridge.stdin.write("Start held turn\r");
					await waitUntil(() => requests.length === 1, "held provider request", output);
				}

				bridge.stdin.write(`${UNKNOWN_INPUT}${key}`);
				await waitUntil(
					() => screen().includes(FEEDBACK) || rawOutput.includes("uncaughtException"),
					"unknown-command feedback",
					output,
				);
				await terminal.flush();
				expect(screen(), output()).toContain(FEEDBACK);
				expect(rawOutput).not.toContain("uncaughtException");
				expect(rawOutput).not.toMatch(/at AgentSession\.|agent-session\.ts:\d+/);
				expect(bridge.exitCode).toBeNull();
				expect(requests).toHaveLength(streaming ? 1 : 0);
				expect(
					sessionEntries().some(
						(entry) => entry.type === "message" && JSON.stringify(entry.message).includes(UNKNOWN_INPUT),
					),
				).toBe(false);

				// Rejected input remains recallable, but the editor is clear and still owns keyboard focus.
				bridge.stdin.write("\x1b[A");
				await waitUntil(() => screen().includes(UNKNOWN_INPUT), "rejected input in editor history", output);
				bridge.stdin.write("\x15/name after-rejection\r");
				await waitUntil(
					() => screen().includes("Session name set: after-rejection"),
					"built-in command after rejection",
					output,
				);
				expect(requests).toHaveLength(streaming ? 1 : 0);
				if (streaming) {
					respond(requests[0]);
					await waitUntil(() => completedTurns() === 1, "held turn completion", output);
				}

				bridge.stdin.write("/example preserved arguments\r");
				await waitUntil(() => completedTurns() === (streaming ? 2 : 1), "template turn completion", output);
				expect(userTexts(requests.at(-1)!)).toContain("Expanded template: preserved arguments");
				bridge.stdin.write("Ordinary prompt after rejection\r");
				await waitUntil(() => completedTurns() === (streaming ? 3 : 2), "ordinary prompt completion", output);
				expect(userTexts(requests.at(-1)!)).toContain("Ordinary prompt after rejection");
				expect(requests.every((request) => userTexts(request).every((text) => !text.includes(UNKNOWN_INPUT)))).toBe(
					true,
				);
				expect(bridge.exitCode).toBeNull();
				expect(stderr).toBe("");
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
