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
type SubmissionScenario = { streaming: boolean; key: string };
type TestFixture = {
	paths: ReturnType<typeof createHeadlessPaths>;
	terminal: VirtualTerminal;
	requests: ProviderRequest[];
	provider?: Awaited<ReturnType<typeof createProviderServer>>;
	bridge?: ChildProcessWithoutNullStreams;
	rawOutput: string;
	stderr: string;
};
type RunningFixture = TestFixture & { bridge: ChildProcessWithoutNullStreams };

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

function screen(fixture: TestFixture): string {
	return fixture.terminal.getViewport().join("\n");
}

function output(fixture: TestFixture): string {
	return `${fixture.rawOutput.slice(-4000)}\n${fixture.stderr}`;
}

function readSessionEntries(fixture: TestFixture) {
	const file = readdirSync(fixture.paths.sessionDir, { recursive: true }).find(
		(entry) => typeof entry === "string" && entry.endsWith(".jsonl"),
	);
	return typeof file === "string" ? SessionManager.open(join(fixture.paths.sessionDir, file)).getEntries() : [];
}

function countCompletedTurns(fixture: TestFixture): number {
	return readSessionEntries(fixture).filter(
		(entry) =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn",
	).length;
}

function respondToRequest(fixture: TestFixture, request: ProviderRequest): void {
	fixture.provider?.getSocket()?.write(
		`${JSON.stringify({
			type: "response",
			requestId: request.id,
			message: fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Test complete" }), {
				stopReason: "toolUse",
			}),
		})}\n`,
	);
}

function writeTestSettings(fixture: TestFixture): void {
	mkdirSync(join(fixture.paths.agentDir, "prompts"));
	writeFileSync(join(fixture.paths.agentDir, "prompts", "example.md"), "Expanded template: $ARGUMENTS");
	writeFileSync(
		join(fixture.paths.agentDir, "settings.json"),
		JSON.stringify({ approvalPreset: "auto-approve", approvalPolicy: "auto-approve", quietStartup: true }),
	);
}

function spawnPtyBridge(fixture: TestFixture): ChildProcessWithoutNullStreams {
	const fixtureDir = join(import.meta.dirname, "..", "fixtures");
	const bridge = spawn(
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
			fixture.paths.sessionDir,
			"--no-context-files",
			"--no-skills",
			"--no-themes",
			"--no-extensions",
			"--extension",
			join(fixtureDir, "interactive-pty-provider-extension.ts"),
		],
		{
			cwd: fixture.paths.workspaceDir,
			env: {
				...process.env,
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				PI_CODING_AGENT_DIR: fixture.paths.agentDir,
				PI_CODING_AGENT_STATE_DIR: fixture.paths.agentDir,
				PI_CODING_AGENT_SESSION_DIR: fixture.paths.sessionDir,
				PI_HEADLESS_PROVIDER_SOCKET: fixture.paths.socketPath,
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
		fixture.rawOutput += text;
		fixture.terminal.write(text);
	});
	bridge.stderr.on("data", (chunk: Buffer) => {
		fixture.stderr += chunk.toString();
	});
	return bridge;
}

async function startInteractiveSession(fixture: TestFixture, streaming: boolean): Promise<RunningFixture> {
	writeTestSettings(fixture);
	fixture.provider = await createProviderServer(fixture.paths.socketPath, (request) => {
		fixture.requests.push(request);
		// Keep a real provider request open while testing the streaming rejection boundary.
		if (streaming && fixture.requests.length === 1) return;
		respondToRequest(fixture, request);
	});
	const bridge = spawnPtyBridge(fixture);
	fixture.bridge = bridge;
	await waitUntil(
		() => screen(fixture).includes("headless-faux-1"),
		"interactive startup",
		() => output(fixture),
	);
	if (streaming) {
		bridge.stdin.write("Start held turn\r");
		await waitUntil(
			() => fixture.requests.length === 1,
			"held provider request",
			() => output(fixture),
		);
	}
	return Object.assign(fixture, { bridge });
}

async function submitUnknownCommandAndAssertRejection(
	fixture: RunningFixture,
	{ streaming, key }: SubmissionScenario,
): Promise<void> {
	fixture.bridge.stdin.write(`${UNKNOWN_INPUT}${key}`);
	await waitUntil(
		() => screen(fixture).includes(FEEDBACK) || fixture.rawOutput.includes("uncaughtException"),
		"unknown-command feedback",
		() => output(fixture),
	);
	await fixture.terminal.flush();
	expect(screen(fixture), output(fixture)).toContain(FEEDBACK);
	expect(fixture.rawOutput).not.toContain("uncaughtException");
	expect(fixture.rawOutput).not.toMatch(/at AgentSession\.|agent-session\.ts:\d+/);
	expect(fixture.bridge.exitCode).toBeNull();
	expect(fixture.requests).toHaveLength(streaming ? 1 : 0);
	expect(
		readSessionEntries(fixture).some(
			(entry) => entry.type === "message" && JSON.stringify(entry.message).includes(UNKNOWN_INPUT),
		),
	).toBe(false);
}

async function assertKeyboardRecovery(fixture: RunningFixture, streaming: boolean): Promise<void> {
	// Rejected input remains recallable, but the editor is clear and still owns keyboard focus.
	fixture.bridge.stdin.write("\x1b[A");
	await waitUntil(
		() => screen(fixture).includes(UNKNOWN_INPUT),
		"rejected input in editor history",
		() => output(fixture),
	);
	fixture.bridge.stdin.write("\x15/name after-rejection\r");
	await waitUntil(
		() => screen(fixture).includes("Session name set: after-rejection"),
		"built-in command after rejection",
		() => output(fixture),
	);
	expect(fixture.requests).toHaveLength(streaming ? 1 : 0);
	if (!streaming) return;
	const heldRequest = fixture.requests[0];
	if (!heldRequest) throw new Error("Missing held provider request");
	respondToRequest(fixture, heldRequest);
	await waitUntil(
		() => countCompletedTurns(fixture) === 1,
		"held turn completion",
		() => output(fixture),
	);
}

async function submitPromptAndAssertText(
	fixture: RunningFixture,
	prompt: string,
	expectedText: string,
	expectedTurns: number,
): Promise<void> {
	fixture.bridge.stdin.write(`${prompt}\r`);
	await waitUntil(
		() => countCompletedTurns(fixture) === expectedTurns,
		`${prompt} turn completion`,
		() => output(fixture),
	);
	const request = fixture.requests.at(-1);
	if (!request) throw new Error(`Missing provider request for ${prompt}`);
	expect(userTexts(request)).toContain(expectedText);
}

async function assertSupportedPrompts(fixture: RunningFixture, streaming: boolean): Promise<void> {
	await submitPromptAndAssertText(
		fixture,
		"/example preserved arguments",
		"Expanded template: preserved arguments",
		streaming ? 2 : 1,
	);
	await submitPromptAndAssertText(
		fixture,
		"Ordinary prompt after rejection",
		"Ordinary prompt after rejection",
		streaming ? 3 : 2,
	);
	expect(fixture.requests.every((request) => userTexts(request).every((text) => !text.includes(UNKNOWN_INPUT)))).toBe(
		true,
	);
	expect(fixture.bridge.exitCode).toBeNull();
	expect(fixture.stderr).toBe("");
}

async function cleanUpFixture(fixture: TestFixture): Promise<void> {
	if (fixture.bridge) await stopBridge(fixture.bridge);
	fixture.provider?.getSocket()?.destroy();
	const provider = fixture.provider;
	if (provider) {
		await new Promise<void>((resolve, reject) =>
			provider.server.close((error) => (error ? reject(error) : resolve())),
		);
	}
	rmSync(fixture.paths.tempDir, { recursive: true, force: true });
}

it.skipIf(process.platform === "win32").each([
	{ name: "idle Enter", streaming: false, key: "\r" },
	{ name: "idle Alt+Enter", streaming: false, key: "\x1b\r" },
	{ name: "streaming Enter", streaming: true, key: "\r" },
	{ name: "streaming Alt+Enter", streaming: true, key: "\x1b\r" },
])(
	"rejects unknown slash input inside the live TUI ($name)",
	async (scenario) => {
		const fixture: TestFixture = {
			paths: createHeadlessPaths(),
			terminal: new VirtualTerminal(100, 24),
			requests: [],
			rawOutput: "",
			stderr: "",
		};
		await runWithCleanup(
			async () => {
				const running = await startInteractiveSession(fixture, scenario.streaming);
				await submitUnknownCommandAndAssertRejection(running, scenario);
				await assertKeyboardRecovery(running, scenario.streaming);
				await assertSupportedPrompts(running, scenario.streaming);
			},
			() => cleanUpFixture(fixture),
		);
	},
	40_000,
);
