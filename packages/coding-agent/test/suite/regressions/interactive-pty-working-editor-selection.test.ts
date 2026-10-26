import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import xterm from "@xterm/headless";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

const PROMPT = "Select this unfinished prompt with the mouse";

async function assertNoEditorRowWrites(before: string, during: string, row: number): Promise<void> {
	const terminal = new xterm.Terminal({ cols: 120, rows: 50, allowProposedApi: true });
	const write = (text: string) => new Promise<void>((resolve) => terminal.write(text, resolve));
	await write(before);
	const tokens = during.match(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[^[]|[\s\S]/gu) ?? [];
	for (const token of tokens) {
		const cursorRow = terminal.buffer.active.cursorY;
		const printable = !token.startsWith("\x1b") && !/[\x00-\x1f\x7f]/u.test(token);
		const clearsLine = /^\x1b\[[0-2]?K$/u.test(token);
		const clearsScreen = /^\x1b\[[0-3]?J$/u.test(token);
		if ((printable || clearsLine) && cursorRow === row) {
			throw new Error(`Terminal wrote to editor row ${row}: ${JSON.stringify(token)}`);
		}
		const clearsEditor = token === "\x1b[1J" ? cursorRow >= row : token === "\x1b[2J" || cursorRow <= row;
		if (clearsScreen && clearsEditor) {
			throw new Error(`Terminal cleared editor row ${row}: ${JSON.stringify(token)}`);
		}
		await write(token);
	}
	terminal.dispose();
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

it.skipIf(process.platform === "win32")(
	"does not repaint the editable prompt during working animation",
	async () => {
		const paths = createHeadlessPaths();
		const terminal = new VirtualTerminal(120, 50);
		let bridge: ChildProcessWithoutNullStreams | undefined;
		let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
		let requests = 0;
		let output = "";
		await runWithCleanup(
			async () => {
				writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));
				provider = await createProviderServer(paths.socketPath, () => {
					requests++;
				});
				const fixtures = join(import.meta.dirname, "..", "fixtures");
				bridge = spawn(
					"python3",
					[
						join(fixtures, "interactive-pty-bridge.py"),
						"50",
						"120",
						process.execPath,
						"--experimental-strip-types",
						"--import",
						pathToFileURL(join(fixtures, "interactive-pty-provider-preload.ts")).href,
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
						join(fixtures, "interactive-pty-provider-extension.ts"),
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
					output += text;
					terminal.write(text);
				});
				await waitUntil(() => output.includes("headless-faux-1"), "interactive startup");
				bridge.stdin.write("Start held provider\r");
				await waitUntil(() => requests === 1, "held provider request");
				bridge.stdin.write(PROMPT);
				await waitUntil(() => output.includes(PROMPT), "editable prompt");
				await terminal.flush();
				const initial = terminal.getViewport();
				const row = initial.findIndex((line) => line.includes(PROMPT));
				expect(row).toBeGreaterThanOrEqual(0);
				const start = output.length;
				const statusFrames = new Set<string>();
				for (let i = 0; i < 20; i++) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					await terminal.flush();
					const screen = terminal.getViewport();
					expect(screen[row]).toBe(initial[row]);
					const status = screen.find((line) => line.includes("Thinking..."));
					if (status) statusFrames.add(status);
				}
				expect(statusFrames.size).toBeGreaterThanOrEqual(2);
				await assertNoEditorRowWrites(output.slice(0, start), output.slice(start), row);
				expect(requests).toBe(1);
				expect(provider?.getSocket()?.destroyed).toBe(false);
				expect(bridge.exitCode).toBeNull();
			},
			async () => {
				if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
					const exited = new Promise<void>((resolve) => bridge?.once("close", () => resolve()));
					bridge.kill("SIGTERM");
					await exited;
				}
				provider?.getSocket()?.destroy();
				if (provider)
					await new Promise<void>((resolve, reject) =>
						provider?.server.close((error) => (error ? reject(error) : resolve())),
					);
				rmSync(paths.tempDir, { recursive: true, force: true });
			},
		);
	},
	30_000,
);
