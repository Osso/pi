import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { CODEX_FALLBACK_PROVIDERS } from "../../../src/core/codex-quota-fallback.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { getMessageText } from "../harness.ts";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

const REPORT_VALUES = [
	"openai-codex",
	"openai-codex-gc",
	"openai-codex-team",
	"usage-all@example.test",
	"pro",
	"23%",
	"41%",
	"2029-12-31 18:00",
	"2030-01-07 18:00",
	"not logged in",
	"claude-selected@example.test",
	"37%",
	"59%",
	"2030-01-01 21:04",
	"2030-01-07 23:06",
	"claude-error@example.test",
	"Fixture Claude account unavailable",
];

type ProviderRequest = { id: string; messages: Message[] };
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

async function waitUntil(fixture: Fixture, predicate: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		await fixture.terminal.flush();
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}\n${viewport(fixture)}\n${fixture.stderr}`);
}

function readSessionEntries(fixture: Fixture) {
	const file = readdirSync(fixture.paths.sessionDir, { recursive: true }).find(
		(entry) => typeof entry === "string" && entry.endsWith(".jsonl"),
	);
	return typeof file === "string" ? SessionManager.open(join(fixture.paths.sessionDir, file)).getEntries() : [];
}

function readUsageMessages(fixture: Fixture) {
	return readSessionEntries(fixture).filter(
		(entry) => entry.type === "custom_message" && entry.customType === "usage-all",
	);
}

function respond(fixture: Fixture, request: ProviderRequest, tool: string): void {
	const socket = fixture.provider?.getSocket();
	if (!socket) throw new Error("Faux provider is not connected");
	socket.write(
		`${JSON.stringify({
			type: "response",
			requestId: request.id,
			message: fauxAssistantMessage(
				fauxToolCall(tool, tool === "end_turn" ? { reason: "Usage all test complete" } : {}),
				{ stopReason: "toolUse" },
			),
		})}\n`,
	);
}

function writeIsolatedUsageConfig(fixture: Fixture): void {
	const auth = Object.fromEntries(
		[
			{ provider: "openai-codex", account: "usage-all-personal", email: "usage-all@example.test" },
			{ provider: "openai-codex-gc", account: "usage-all-gc", email: "usage-all-gc@example.test" },
		].map(({ provider, account, email }) => {
			const payload = Buffer.from(
				JSON.stringify({ email, "https://api.openai.com/auth": { chatgpt_account_id: account } }),
			).toString("base64url");
			return [
				provider,
				{
					type: "oauth",
					access: `test.${payload}.signature`,
					refresh: "fake-refresh",
					expires: Date.now() + 86_400_000,
				},
			];
		}),
	);
	writeFileSync(join(fixture.paths.agentDir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
	writeFileSync(
		join(fixture.paths.agentDir, "settings.json"),
		JSON.stringify({ approvalPreset: "auto-approve", approvalPolicy: "auto-approve", quietStartup: true }),
	);
}

function spawnUsageBridge(fixture: Fixture): ChildProcessWithoutNullStreams {
	const fixtures = join(import.meta.dirname, "..", "fixtures");
	const newFixtures = join(import.meta.dirname, "..", "..", "fixtures");
	const bridge = spawn(
		"python3",
		[
			join(fixtures, "interactive-pty-bridge.py"),
			"50",
			"180",
			process.execPath,
			"--experimental-strip-types",
			"--import",
			pathToFileURL(join(newFixtures, "interactive-usage-all-preload.ts")).href,
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
			"--extension",
			join(fixtures, "interactive-pty-provider-extension.ts"),
			"--extension",
			join(fixtures, "interactive-usage-held-tool.ts"),
			"--extension",
			join(newFixtures, "interactive-usage-all-bridge.ts"),
			"--extension",
			join(import.meta.dirname, "..", "..", "..", "extensions", "codex-usage", "src", "index.ts"),
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
				PI_HEADLESS_PROVIDER_ABORT_LOG: join(fixture.paths.tempDir, "provider-aborted"),
				PI_TEST_USAGE_FETCH_LOG: join(fixture.paths.tempDir, "usage-fetch"),
				PI_TEST_USAGE_RELEASE: join(fixture.paths.tempDir, "release"),
				PI_TUI_WRITE_LOG: "",
				PI_DEBUG_REDRAW: "0",
				PI_TUI_DEBUG: "0",
				TERM: "xterm-256color",
				NO_COLOR: "1",
			},
		},
	);
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

function assertReportContent(text: string): void {
	for (const value of REPORT_VALUES) expect(text).toContain(value);
	for (const provider of CODEX_FALLBACK_PROVIDERS.keys()) expect(text).toContain(provider);
	const rows = text.split("\n");
	expect(text).toContain("Resets = available reset credits");
	expect(text).toContain("Resets Central (5h | week)");
	expect(rows.find((row) => row.includes("usage-all@example.test"))).toMatch(/23%\s+41%\s+-\s+Codex/);
	expect(rows.find((row) => row.includes("claude-selected@example.test"))).toMatch(/37%\s+59%\s+-\s+Claude/);
	expect(rows.find((row) => row.includes("openai-codex-gc"))).toMatch(/error/i);
	expect(rows.find((row) => row.includes("openai-codex-team"))).toContain("not logged in");
	expect(rows.find((row) => row.includes("claude-selected@example.test"))).toContain("*");
	expect(rows.find((row) => row.includes("claude-error@example.test"))).toMatch(/error/i);
}

async function finishTurn(fixture: Fixture, expectedCompletions: number): Promise<void> {
	const request = fixture.requests.at(-1);
	if (!request) throw new Error("Missing held provider request");
	respond(fixture, request, "end_turn");
	await waitUntil(
		fixture,
		() =>
			readSessionEntries(fixture).filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "end_turn",
			).length === expectedCompletions,
		"turn completion after release",
	);
}

async function assertBusyUsageAll(fixture: Fixture): Promise<void> {
	writeIsolatedUsageConfig(fixture);
	fixture.provider = await createProviderServer(fixture.paths.socketPath, (request) => {
		fixture.requests.push(request);
		if (fixture.requests.length === 1) respond(fixture, request, "held_usage_tool");
	});
	const bridge = spawnUsageBridge(fixture);
	const release = join(fixture.paths.tempDir, "release");
	await waitUntil(fixture, () => viewport(fixture).includes("headless-faux-codex"), "model startup");
	bridge.stdin.write("Start held usage all turn\r");
	await waitUntil(
		fixture,
		() => existsSync(`${release}.started`) && viewport(fixture).includes("Waiting for tool"),
		"pending tool",
	);
	bridge.stdin.write("/usage all\r");
	await waitUntil(
		fixture,
		() => REPORT_VALUES.every((value) => viewport(fixture).includes(value)),
		"all account rows while busy",
	);
	assertReportContent(viewport(fixture));
	const fetches = readFileSync(join(fixture.paths.tempDir, "usage-fetch"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(fetches).toEqual(expect.arrayContaining([{ account: "usage-all-personal" }, { account: "usage-all-gc" }]));
	expect(new Set(fetches.map((entry: { account: string }) => entry.account))).toEqual(
		new Set(["usage-all-personal", "usage-all-gc"]),
	);
	expect(fixture.requests).toHaveLength(1);
	expect(existsSync(`${release}.completed`)).toBe(false);
	expect(existsSync(`${release}.aborted`)).toBe(false);
	expect(existsSync(join(fixture.paths.tempDir, "provider-aborted"))).toBe(false);
	expect(bridge.exitCode).toBeNull();
	writeFileSync(release, "release");
	await waitUntil(fixture, () => fixture.requests.length === 2, "continuation after tool release");
	expect(existsSync(`${release}.completed`)).toBe(true);
	expect(fixture.requests[1]?.messages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ role: "toolResult", toolName: "held_usage_tool", isError: false }),
		]),
	);
	await finishTurn(fixture, 1);
	// Busy reports queue for persistence on the next user turn, as in the existing /usage regression.
	bridge.stdin.write("Next user turn consumes usage all report\r");
	await waitUntil(
		fixture,
		() => fixture.requests.length === 3 && readUsageMessages(fixture).length > 0,
		"persisted usage-all report",
	);
	const reports = readUsageMessages(fixture);
	expect(reports).toHaveLength(1);
	const reportText = getMessageText(reports[0]);
	assertReportContent(reportText);
	expect(fixture.requests[2]?.messages.map(getMessageText)).toContain(reportText);
	await finishTurn(fixture, 2);
	expect(readUsageMessages(fixture)).toHaveLength(1);
	expect(fixture.requests).toHaveLength(3);
	expect(fixture.rawOutput).not.toContain("uncaughtException");
	expect(fixture.stderr).toBe("");
}

async function cleanup(fixture: Fixture): Promise<void> {
	const bridge = fixture.bridge;
	if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
		const exited = new Promise<void>((resolve) => bridge.once("close", () => resolve()));
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

it.skipIf(process.platform === "win32")(
	"renders one /usage all report without interrupting a pending tool",
	async () => {
		const fixture: Fixture = {
			paths: createHeadlessPaths(undefined, "openai-codex"),
			terminal: new VirtualTerminal(180, 50),
			requests: [],
			rawOutput: "",
			stderr: "",
		};
		await runWithCleanup(
			() => assertBusyUsageAll(fixture),
			() => cleanup(fixture),
		);
	},
	60_000,
);
