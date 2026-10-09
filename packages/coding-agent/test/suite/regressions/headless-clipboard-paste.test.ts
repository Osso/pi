import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

// A concrete 1x1 PNG, including IHDR, IDAT, and IEND chunks.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
	"base64",
);

async function waitUntil(predicate: () => boolean, description: string, output: () => string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}; PTY output: ${output().slice(-4000)}`);
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

async function stopClipboardFixture(
	bridge: ChildProcessWithoutNullStreams | undefined,
	provider: Awaited<ReturnType<typeof createProviderServer>> | undefined,
	tempDir: string,
): Promise<void> {
	if (bridge) await stopBridge(bridge);
	provider?.getSocket()?.destroy();
	if (provider) {
		await new Promise<void>((resolve, reject) =>
			provider.server.close((error) => (error ? reject(error) : resolve())),
		);
	}
	rmSync(tempDir, { recursive: true, force: true });
}

function createHeadlessClipboardEnvironment(
	paths: ReturnType<typeof createHeadlessPaths>,
	binDir: string,
	clipboardDir: string,
	cacheDir: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		TMPDIR: clipboardDir,
		XDG_SESSION_TYPE: "tty",
		NODE_COMPILE_CACHE: cacheDir,
		PI_CODING_AGENT_DIR: paths.agentDir,
		PI_CODING_AGENT_STATE_DIR: paths.agentDir,
		PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
		PI_HEADLESS_PROVIDER_SOCKET: paths.socketPath,
		PI_TUI_WRITE_LOG: "",
		PI_DEBUG_REDRAW: "0",
		PI_TUI_DEBUG: "0",
		TERM: "xterm-256color",
		NO_COLOR: "1",
	};
	const displayVariables = new Set(["DISPLAY", "WAYLAND_DISPLAY", "TERMUX_VERSION"]);
	for (const key of Object.keys(env)) {
		if (displayVariables.has(key) || key.startsWith("WSL")) delete env[key];
	}
	return env;
}

it.skipIf(process.platform !== "linux")(
	"pastes exact PNG bytes through real interactive Ctrl+V without a display and leaves missing clipboard unchanged",
	async () => {
		const paths = createHeadlessPaths();
		const binDir = join(paths.tempDir, "bin");
		const clipboardDir = join(paths.tempDir, "clipboard");
		const sourcePath = join(paths.tempDir, "source.png");
		const callsPath = join(paths.tempDir, "wl-paste-calls.jsonl");
		const cacheDir = join(paths.tempDir, "compile-cache");
		for (const directory of [binDir, clipboardDir, cacheDir]) mkdirSync(directory);
		writeFileSync(sourcePath, PNG);
		writeFileSync(callsPath, "");
		writeFileSync(
			join(binDir, "wl-paste"),
			`#!/usr/bin/env python3
import json
import pathlib
import sys

source = pathlib.Path(${JSON.stringify(sourcePath)})
with open(${JSON.stringify(callsPath)}, "a") as calls:
    calls.write(json.dumps(sys.argv[1:]) + "\\n")
if not source.exists():
    sys.exit(1)
if sys.argv[1:] == ["--list-types"]:
    sys.stdout.write("image/png\\n")
elif sys.argv[1:] == ["--type", "image/png", "--no-newline"]:
    sys.stdout.buffer.write(source.read_bytes())
else:
    sys.exit(2)
`,
			{ mode: 0o755 },
		);
		const env = createHeadlessClipboardEnvironment(paths, binDir, clipboardDir, cacheDir);
		const terminal = new VirtualTerminal(160, 24);
		let bridge: ChildProcessWithoutNullStreams | undefined;
		let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
		let requests = 0;
		let rawOutput = "";
		let stderr = "";
		const output = () => `${rawOutput.slice(-4000)}\n${stderr}`;
		const screen = () => terminal.getViewport().join("\n");
		await runWithCleanup(
			async () => {
				provider = await createProviderServer(paths.socketPath, () => {
					requests++;
				});
				const fixtures = join(import.meta.dirname, "..", "fixtures");
				bridge = spawn(
					"python3",
					[
						join(fixtures, "interactive-pty-bridge.py"),
						"24",
						"160",
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
					{ cwd: paths.workspaceDir, env },
				);
				bridge.stdout.setEncoding("utf8");
				bridge.stdout.on("data", (text: string) => {
					rawOutput += text;
					terminal.write(text);
				});
				bridge.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				await waitUntil(() => rawOutput.includes("headless-faux-1"), "interactive editor", output);
				bridge.stdin.write("\x16");
				await waitUntil(() => screen().includes("pi-clipboard-"), "visible pasted clipboard path", output);
				await terminal.flush();
				const files = readdirSync(clipboardDir).filter((name) => /^pi-clipboard-.*\.png$/.test(name));
				expect(files).toHaveLength(1);
				const savedPath = join(clipboardDir, files[0]);
				expect(screen()).toContain(savedPath);
				expect(readFileSync(savedPath)).toEqual(PNG);
				expect(
					readFileSync(callsPath, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line)),
				).toEqual([["--list-types"], ["--type", "image/png", "--no-newline"]]);

				unlinkSync(sourcePath);
				bridge.stdin.write("\x16");
				await waitUntil(
					() => readFileSync(callsPath, "utf8").trim().split("\n").length === 3,
					"missing clipboard read",
					output,
				);
				// A following key proves the editor remains usable after the failed paste.
				bridge.stdin.write(" no-image");
				await waitUntil(
					() => screen().includes(`${savedPath} no-image`),
					"unchanged editor after missing image",
					output,
				);
				await new Promise((resolve) => setTimeout(resolve, 500));
				await terminal.flush();
				expect(screen()).toContain(`${savedPath} no-image`);
				expect(screen().match(/pi-clipboard-/g)).toHaveLength(1);
				expect(readdirSync(clipboardDir).filter((name) => name.startsWith("pi-clipboard-"))).toEqual(files);
				expect(requests).toBe(0);
			},
			() => stopClipboardFixture(bridge, provider, paths.tempDir),
		);
	},
	40_000,
);
