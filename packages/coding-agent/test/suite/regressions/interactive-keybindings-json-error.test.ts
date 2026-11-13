import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

const INVALID_KEYBINDINGS = '{ "app.model.select": "ctrl+y", }';

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

function spawnInteractivePi(paths: ReturnType<typeof createHeadlessPaths>): ChildProcessWithoutNullStreams {
	const fixtureDir = join(import.meta.dirname, "..", "fixtures");
	return spawn(
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
}

it.skipIf(process.platform === "win32")(
	"shows a keybindings.json parse error at interactive startup",
	async () => {
		const paths = createHeadlessPaths();
		const terminal = new VirtualTerminal(100, 24);
		let rawOutput = "";
		let bridge: ChildProcessWithoutNullStreams | undefined;
		let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
		const screen = () => terminal.getViewport().join("\n");
		await runWithCleanup(
			async () => {
				writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));
				writeFileSync(join(paths.agentDir, "keybindings.json"), INVALID_KEYBINDINGS);
				provider = await createProviderServer(paths.socketPath, () => {});
				bridge = spawnInteractivePi(paths);
				bridge.stdout.setEncoding("utf8");
				bridge.stdout.on("data", (text: string) => {
					rawOutput += text;
					terminal.write(text);
				});
				await waitUntil(
					() => screen().includes("keybindings.json error"),
					"keybindings.json error",
					() => rawOutput.slice(-4000),
				);
				await terminal.flush();
				expect(screen()).toMatch(/keybindings\.json error: .*JSON.*; using default keybindings/s);
			},
			async () => {
				if (bridge) await stopBridge(bridge);
				provider?.getSocket()?.destroy();
				const server = provider?.server;
				if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
				rmSync(paths.tempDir, { recursive: true, force: true });
			},
		);
	},
	30_000,
);

it("clears the keybindings.json error and applies bindings after the file is fixed and reloaded", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-keybindings-error-"));
	try {
		writeFileSync(join(agentDir, "keybindings.json"), INVALID_KEYBINDINGS);
		const keybindings = KeybindingsManager.create(agentDir);
		expect(keybindings.getError()).toMatch(/JSON/);
		expect(keybindings.getKeys("app.model.select")).not.toContain("ctrl+y");

		writeFileSync(join(agentDir, "keybindings.json"), '{ "app.model.select": "ctrl+y" }');
		keybindings.reload();

		expect(keybindings.getError()).toBeUndefined();
		expect(keybindings.getKeys("app.model.select")).toEqual(["ctrl+y"]);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
