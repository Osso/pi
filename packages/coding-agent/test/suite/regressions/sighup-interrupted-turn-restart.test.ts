import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

type WireLlmRequest = Parameters<Parameters<typeof createProviderServer>[1]>[0];

const PROMPT = "Hold this turn open";
const fixtureDir = join(import.meta.dirname, "..", "fixtures");

async function waitUntil(predicate: () => boolean, description: string, output: () => string): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}; ${output()}`);
}

function spawnInteractivePi(paths: ReturnType<typeof createHeadlessPaths>, lifecycleExtension: string) {
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
			"--extension",
			lifecycleExtension,
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
				TERM: "xterm-256color",
				NO_COLOR: "1",
			},
		},
	);
}

function piPid(bridge: ChildProcessWithoutNullStreams): number {
	const children = readFileSync(`/proc/${bridge.pid}/task/${bridge.pid}/children`, "utf8").trim().split(/\s+/);
	return Number(children[0]);
}

async function stopBridge(bridge: ChildProcessWithoutNullStreams): Promise<void> {
	if (bridge.exitCode !== null || bridge.signalCode !== null) return;
	const closed = new Promise<void>((resolve) => bridge.once("close", () => resolve()));
	bridge.kill("SIGTERM");
	const timer = setTimeout(() => bridge.kill("SIGKILL"), 2_500);
	await closed;
	clearTimeout(timer);
}

it.skipIf(process.platform !== "linux")(
	"SIGHUP during a turn restarts into session_start(restart) and continues the interrupted turn",
	async () => {
		const paths = createHeadlessPaths();
		const startEventsFile = join(paths.tempDir, "session-start.jsonl");
		const lifecycleExtension = join(paths.tempDir, "record-session-start.ts");
		writeFileSync(
			lifecycleExtension,
			`import { appendFileSync } from "node:fs";
export default function (pi) {
	pi.on("session_start", (event) => {
		appendFileSync(${JSON.stringify(startEventsFile)}, JSON.stringify({ reason: event.reason, previousSessionFile: event.previousSessionFile, pid: process.pid }) + "\\n");
	});
}
`,
		);
		writeFileSync(
			join(paths.agentDir, "settings.json"),
			JSON.stringify({ approvalPreset: "auto-approve", approvalPolicy: "auto-approve", quietStartup: true }),
		);
		const requests: WireLlmRequest[] = [];
		const provider = await createProviderServer(paths.socketPath, (request) => requests.push(request));
		let rawOutput = "";
		const bridge = spawnInteractivePi(paths, lifecycleExtension);
		bridge.stdout.on("data", (chunk: Buffer) => {
			rawOutput += chunk.toString();
		});
		const output = () => rawOutput.slice(-3000);
		const startEvents = () => {
			try {
				return readFileSync(startEventsFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { reason: string; previousSessionFile?: string; pid: number });
			} catch {
				return [];
			}
		};

		await runWithCleanup(
			async () => {
				await waitUntil(() => startEvents().length === 1, "initial session_start", output);
				await waitUntil(() => rawOutput.includes("headless-faux-1"), "interactive startup", output);
				bridge.stdin.write(`${PROMPT}\r`);
				await waitUntil(() => requests.length === 1, "held provider request", output);

				const pid = piPid(bridge);
				process.kill(pid, "SIGHUP");
				await waitUntil(() => requests.length === 2, "continuation request after SIGHUP", output);

				const continued = requests[1];
				if (!continued) throw new Error("Missing continuation request");
				const transcript = JSON.stringify(continued.messages);
				expect(transcript).toContain("restarted");
				expect(transcript.split(PROMPT)).toHaveLength(2);
				const [initial, restarted] = startEvents();
				expect(initial?.reason).toBe("startup");
				expect(restarted).toMatchObject({ reason: "restart", pid });
				expect(restarted?.previousSessionFile).toMatch(/\.jsonl$/);

				provider.getSocket()?.write(
					`${JSON.stringify({
						type: "response",
						requestId: continued.id,
						message: fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Resumed" }), {
							stopReason: "toolUse",
						}),
					})}\n`,
				);
			},
			async () => {
				await stopBridge(bridge);
				provider.getSocket()?.destroy();
				await new Promise<void>((resolve) => provider.server.close(() => resolve()));
				rmSync(paths.tempDir, { recursive: true, force: true });
			},
		);
	},
	60_000,
);
