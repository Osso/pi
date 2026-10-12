import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { getMessageText } from "../harness.ts";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

const REPORT_LINES = [
	"OpenAI Codex usage",
	"User: usage-pty@example.test",
	"Account: usage-pty-account",
	"Plan: pro",
	"Reset credits: 3 available",
	"codex: 5-hour usage 23% of 300m window resets 2030-01-01 00:00",
	"codex: weekly usage 41% of 10080m window resets 2030-01-01 00:00",
	"codex: credits balance 12.50",
	"codex_review (Review): primary 7% of 60m window resets 2030-01-01 00:00",
];

type ProviderRequest = { id: string; messages: Message[] };
type Scenario = { state: "tool" | "provider"; key: string };
type Fixture = {
	paths: ReturnType<typeof createHeadlessPaths>;
	terminal: VirtualTerminal;
	requests: ProviderRequest[];
	provider?: Awaited<ReturnType<typeof createProviderServer>>;
	bridge?: ChildProcessWithoutNullStreams;
	rawOutput: string;
	stderr: string;
};

function viewport(fixture: Fixture): string {
	return fixture.terminal.getViewport().join("\n");
}

async function waitUntil(fixture: Fixture, predicate: () => boolean, description: string, timeout = 15_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		await fixture.terminal.flush();
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}\n${viewport(fixture)}\n${fixture.stderr}`);
}

function sessionEntries(fixture: Fixture) {
	const file = readdirSync(fixture.paths.sessionDir, { recursive: true }).find(
		(entry) => typeof entry === "string" && entry.endsWith(".jsonl"),
	);
	return typeof file === "string" ? SessionManager.open(join(fixture.paths.sessionDir, file)).getEntries() : [];
}

function respond(fixture: Fixture, request: ProviderRequest, tool: string): void {
	const socket = fixture.provider?.getSocket();
	if (!socket) throw new Error("Faux provider is not connected");
	socket.write(
		`${JSON.stringify({
			type: "response",
			requestId: request.id,
			message: fauxAssistantMessage(
				fauxToolCall(tool, tool === "end_turn" ? { reason: "Usage test complete" } : {}),
				{
					stopReason: "toolUse",
				},
			),
		})}\n`,
	);
}

function writeIsolatedUsageConfig(fixture: Fixture): void {
	const payload = Buffer.from(
		JSON.stringify({
			email: "usage-pty@example.test",
			"https://api.openai.com/auth": { chatgpt_account_id: "usage-pty-account" },
		}),
	).toString("base64url");
	// Only the isolated auth file contains the fake token; no global auth or environment token.
	writeFileSync(
		join(fixture.paths.agentDir, "auth.json"),
		JSON.stringify({ "openai-codex": { type: "api_key", key: `test.${payload}.signature` } }),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(fixture.paths.agentDir, "settings.json"),
		JSON.stringify({ approvalPreset: "auto-approve", approvalPolicy: "auto-approve", quietStartup: true }),
	);
}

async function startHeldProvider(fixture: Fixture, scenario: Scenario): Promise<void> {
	fixture.provider = await createProviderServer(fixture.paths.socketPath, (request) => {
		fixture.requests.push(request);
		if (scenario.state === "tool" && fixture.requests.length === 1) respond(fixture, request, "held_usage_tool");
	});
}

function usageExtensionArgs(fixtures: string): string[] {
	return [
		"--extension",
		join(fixtures, "interactive-pty-provider-extension.ts"),
		"--extension",
		join(fixtures, "interactive-usage-held-tool.ts"),
		"--extension",
		process.env.PI_TEST_USAGE_EXTENSION_PATH ??
			join(import.meta.dirname, "..", "..", "..", "extensions", "codex-usage", "src", "index.ts"),
	];
}

function usageBridgeArgs(fixture: Fixture): string[] {
	const fixtures = join(import.meta.dirname, "..", "fixtures");
	return [
		join(fixtures, "interactive-pty-bridge.py"),
		"50",
		"120",
		process.execPath,
		"--experimental-strip-types",
		"--import",
		pathToFileURL(join(fixtures, "interactive-usage-preload.ts")).href,
		join(import.meta.dirname, "..", "..", "..", "src", "cli.ts"),
		"--provider",
		"openai-codex",
		"--model",
		"headless-faux-codex",
		"--session-dir",
		fixture.paths.sessionDir,
		"--no-context-files",
		"--no-skills",
		"--no-themes",
		"--no-extensions",
		...usageExtensionArgs(fixtures),
	];
}

function usageBridgeEnv(fixture: Fixture): NodeJS.ProcessEnv {
	return {
		...process.env,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		PI_CODING_AGENT_DIR: fixture.paths.agentDir,
		PI_CODING_AGENT_STATE_DIR: fixture.paths.agentDir,
		PI_CODING_AGENT_SESSION_DIR: fixture.paths.sessionDir,
		PI_HEADLESS_PROVIDER_SOCKET: fixture.paths.socketPath,
		PI_HEADLESS_PROVIDER_ABORT_LOG: join(fixture.paths.tempDir, "provider-aborted"),
		PI_TEST_USAGE_FETCH_LOG: join(fixture.paths.tempDir, "usage-fetch"),
		PI_TEST_USAGE_RELEASE: join(fixture.paths.tempDir, "release"),
		PI_TUI_WRITE_LOG: "",
		PI_DEBUG_REDRAW: "0",
		PI_TUI_DEBUG: "0",
		TERM: "xterm-256color",
		NO_COLOR: "1",
	};
}

function spawnUsageBridge(fixture: Fixture): ChildProcessWithoutNullStreams {
	const bridge = spawn("python3", usageBridgeArgs(fixture), {
		cwd: fixture.paths.workspaceDir,
		env: usageBridgeEnv(fixture),
	});
	fixture.bridge = bridge;
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

async function waitForOngoingWork(
	fixture: Fixture,
	scenario: Scenario,
	bridge: ChildProcessWithoutNullStreams,
): Promise<void> {
	const release = join(fixture.paths.tempDir, "release");
	await waitUntil(fixture, () => viewport(fixture).includes("headless-faux-codex"), "Codex model startup");
	bridge.stdin.write("Start held usage turn\r");
	await waitUntil(fixture, () => fixture.requests.length === 1, "first provider request");
	if (scenario.state === "tool") {
		await waitUntil(
			fixture,
			() => existsSync(`${release}.started`) && viewport(fixture).includes("Waiting for tool"),
			"pending held tool in real TUI",
		);
	}
}

async function assertImmediateBusyReport(
	fixture: Fixture,
	scenario: Scenario,
	bridge: ChildProcessWithoutNullStreams,
): Promise<void> {
	bridge.stdin.write(`/usage${scenario.key}`);
	const fetchLog = join(fixture.paths.tempDir, "usage-fetch");
	await waitUntil(fixture, () => existsSync(fetchLog), "mock wham request from real usage extension");
	expect(readFileSync(fetchLog, "utf8").trim()).toBe(JSON.stringify({ account: "usage-pty-account" }));
	await waitUntil(
		fixture,
		() => REPORT_LINES.every((line) => viewport(fixture).includes(line)),
		"full Codex report before busy work is released",
		5_000,
	);
	await new Promise((resolve) => setTimeout(resolve, 100));
	await fixture.terminal.flush();
	for (const line of REPORT_LINES) expect(viewport(fixture)).toContain(line);
	expect(fixture.requests).toHaveLength(1);
	expect(existsSync(join(fixture.paths.tempDir, "provider-aborted"))).toBe(false);
	expect(bridge.exitCode).toBeNull();
}

async function releaseOngoingTool(fixture: Fixture): Promise<void> {
	const release = join(fixture.paths.tempDir, "release");
	expect(viewport(fixture)).toContain("Waiting for tool");
	expect(existsSync(`${release}.completed`)).toBe(false);
	expect(existsSync(`${release}.aborted`)).toBe(false);
	writeFileSync(release, "release");
	await waitUntil(fixture, () => fixture.requests.length === 2, "provider continuation after tool release");
	expect(existsSync(`${release}.completed`)).toBe(true);
	expect(fixture.requests[1]?.messages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ role: "toolResult", toolName: "held_usage_tool", isError: false }),
		]),
	);
}

async function finishOriginalTurn(fixture: Fixture, completedRequests: number): Promise<void> {
	const heldRequest = fixture.requests.at(-1);
	if (!heldRequest) throw new Error("No held provider request");
	respond(fixture, heldRequest, "end_turn");
	await waitUntil(
		fixture,
		() =>
			sessionEntries(fixture).some(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn",
			),
		"original turn finishes after explicit release",
	);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(fixture.requests).toHaveLength(completedRequests);
}

async function assertNextTurnReport(
	fixture: Fixture,
	bridge: ChildProcessWithoutNullStreams,
	completedRequests: number,
): Promise<ProviderRequest> {
	bridge.stdin.write("Next user turn consumes queued usage report\r");
	await waitUntil(fixture, () => fixture.requests.length === completedRequests + 1, "next user turn request");
	const nextRequest = fixture.requests.at(-1);
	if (!nextRequest) throw new Error("Missing next user turn request");
	expect(nextRequest.messages.map(getMessageText)).toContain(REPORT_LINES.join("\n"));
	await waitUntil(
		fixture,
		() =>
			sessionEntries(fixture).some(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "codex-usage" &&
					entry.content === REPORT_LINES.join("\n"),
			),
		"queued report persists on subsequent user turn",
	);
	return nextRequest;
}

async function finishNextTurn(
	fixture: Fixture,
	nextRequest: ProviderRequest,
	completedRequests: number,
): Promise<void> {
	respond(fixture, nextRequest, "end_turn");
	await waitUntil(
		fixture,
		() =>
			sessionEntries(fixture).filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn",
			).length === 2,
		"subsequent user turn completes",
	);
	expect(fixture.requests).toHaveLength(completedRequests + 1);
	expect(fixture.rawOutput).not.toContain("uncaughtException");
	expect(fixture.stderr).toBe("");
}

async function assertBusyReport(fixture: Fixture, scenario: Scenario): Promise<void> {
	writeIsolatedUsageConfig(fixture);
	await startHeldProvider(fixture, scenario);
	const bridge = spawnUsageBridge(fixture);
	await waitForOngoingWork(fixture, scenario, bridge);
	await assertImmediateBusyReport(fixture, scenario, bridge);
	if (scenario.state === "tool") await releaseOngoingTool(fixture);
	const completedRequests = scenario.state === "tool" ? 2 : 1;
	await finishOriginalTurn(fixture, completedRequests);
	const nextRequest = await assertNextTurnReport(fixture, bridge, completedRequests);
	await finishNextTurn(fixture, nextRequest, completedRequests);
}

async function cleanup(fixture: Fixture): Promise<void> {
	const bridge = fixture.bridge;
	if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
		const exited = new Promise<void>((resolve) => bridge.once("close", () => resolve()));
		// Existing PTY bridge terminates and reaps the entire CLI process group.
		bridge.kill("SIGTERM");
		const timeout = setTimeout(() => bridge.kill("SIGKILL"), 5_000);
		await exited;
		clearTimeout(timeout);
	}
	fixture.provider?.getSocket()?.destroy();
	if (fixture.provider) {
		await new Promise<void>((resolve, reject) =>
			fixture.provider?.server.close((error) => (error ? reject(error) : resolve())),
		);
	}
	rmSync(fixture.paths.tempDir, { recursive: true, force: true });
}

it.skipIf(process.platform === "win32").each([
	{ state: "tool", name: "pending tool Enter", key: "\r" },
	{ state: "tool", name: "pending tool Alt+Enter", key: "\x1b\r" },
	{ state: "provider", name: "held provider Enter", key: "\r" },
	{ state: "provider", name: "held provider Alt+Enter", key: "\x1b\r" },
] satisfies Array<Scenario & { name: string }>)(
	"shows /usage immediately without interrupting $name",
	async (scenario) => {
		const fixture: Fixture = {
			paths: createHeadlessPaths(undefined, "openai-codex"),
			terminal: new VirtualTerminal(120, 50),
			requests: [],
			rawOutput: "",
			stderr: "",
		};
		await runWithCleanup(
			() => assertBusyReport(fixture, scenario),
			() => cleanup(fixture),
		);
	},
	40_000,
);
