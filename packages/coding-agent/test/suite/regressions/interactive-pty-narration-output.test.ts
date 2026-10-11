import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type ThinkingContent,
} from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

const fixture = JSON.parse(
	readFileSync(new URL("../../fixtures/anthropic-narration.json", import.meta.url), "utf8"),
) as { content: ThinkingContent[] };
const BASE_ARGS = [
	"--provider",
	"headless-faux",
	"--model",
	"headless-faux-1",
	"--no-context-files",
	"--no-skills",
	"--no-themes",
	"--no-extensions",
];
const FIXTURES = join(import.meta.dirname, "..", "fixtures");
type Paths = ReturnType<typeof createHeadlessPaths>;
type Provider = Awaited<ReturnType<typeof createProviderServer>>;
type PtyRuntime = { process: ChildProcessWithoutNullStreams; terminal: VirtualTerminal; output: () => string };
type Probe = {
	paths: Paths;
	runtime?: PtyRuntime;
	provider?: Provider;
	requests: number;
	replayedContent?: AssistantMessage["content"];
};

async function waitUntil(predicate: () => boolean, description: string, output: () => string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}: ${output().slice(-4000)}`);
}

function buildPtyArguments(paths: Paths, sessionFile?: string): string[] {
	const executable = process.env.PI_TEST_NARRATION_EXECUTABLE;
	const cliPath = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
	const launch = executable ? [executable] : [process.execPath, "--experimental-strip-types", cliPath];
	return [
		join(FIXTURES, "interactive-pty-bridge.py"),
		"24",
		"80",
		...launch,
		...BASE_ARGS,
		"--session-dir",
		paths.sessionDir,
		"--extension",
		join(FIXTURES, "interactive-narration-provider.ts"),
		"--extension",
		join(FIXTURES, "interactive-narration-wait.ts"),
		...(sessionFile ? ["--session", sessionFile] : []),
	];
}

function subscribePtyOutput(processHandle: ChildProcessWithoutNullStreams): PtyRuntime {
	const terminal = new VirtualTerminal(80, 24);
	let output = "";
	processHandle.stdout.setEncoding("utf8");
	processHandle.stdout.on("data", (chunk: string) => {
		output += chunk;
		terminal.write(chunk);
	});
	processHandle.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	return { process: processHandle, terminal, output: () => output };
}

function startPty(paths: Paths, sessionFile?: string): PtyRuntime {
	const processHandle = spawn("python3", buildPtyArguments(paths, sessionFile), {
		cwd: paths.workspaceDir,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: paths.agentDir,
			PI_CODING_AGENT_STATE_DIR: paths.agentDir,
			PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
			PI_HEADLESS_PROVIDER_SOCKET: paths.socketPath,
			PI_TEST_NARRATION_STARTED: join(paths.tempDir, "tool-started"),
			PI_TEST_NARRATION_RELEASE: join(paths.tempDir, "tool-release"),
			PI_TUI_WRITE_LOG: "",
			PI_DEBUG_REDRAW: "0",
			PI_TUI_DEBUG: "0",
			TERM: "xterm-256color",
			NO_COLOR: "1",
		},
	});
	return subscribePtyOutput(processHandle);
}

async function stopPty(runtime: PtyRuntime): Promise<void> {
	if (runtime.process.exitCode !== null || runtime.process.signalCode !== null) return;
	const closed = new Promise<void>((resolve) => runtime.process.once("close", () => resolve()));
	runtime.process.kill("SIGTERM");
	const stopped = await Promise.race([
		closed.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 2500)),
	]);
	if (!stopped) {
		runtime.process.kill("SIGKILL");
		await closed;
	}
}

function expectNarration(runtime: PtyRuntime): void {
	const screen = runtime.terminal.getScrollBuffer().join("\n").replace(/\s+/g, " ");
	for (const excerpt of [
		"Agreed, with the condition",
		"quick checks at merge time",
		"bisection if red",
		"first batch running around 13:00.",
	])
		expect(screen, runtime.output()).toContain(excerpt);
	expect(screen).not.toContain("I lean toward yes, batching makes sense");
}

async function startProbe(probe: Probe): Promise<void> {
	writeFileSync(
		join(probe.paths.agentDir, "settings.json"),
		JSON.stringify({
			approvalPolicy: "auto-approve",
			approvalPreset: "auto-approve",
			hideThinkingBlock: true,
		}),
	);
	probe.provider = await createProviderServer(probe.paths.socketPath, (request) => {
		probe.requests++;
		if (probe.requests === 2)
			probe.replayedContent = request.messages.find((message) => message.role === "assistant")?.content;
		const response =
			probe.requests === 1
				? fauxAssistantMessage([...structuredClone(fixture.content), fauxToolCall("narration_wait", {})], {
						stopReason: "toolUse",
					})
				: fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Done" }), { stopReason: "toolUse" });
		probe.provider
			?.getSocket()
			?.write(`${JSON.stringify({ type: "response", requestId: request.id, message: response })}\n`);
	});
	probe.runtime = startPty(probe.paths);
}

async function verifyLiveNarration(probe: Probe): Promise<void> {
	const runtime = probe.runtime;
	if (!runtime) throw new Error("Narration PTY was not started");
	await waitUntil(() => runtime.output().includes("headless-faux-1"), "interactive startup", runtime.output);
	runtime.process.stdin.write("Opinion on batching full suites?\r");
	await waitUntil(() => existsSync(join(probe.paths.tempDir, "tool-started")), "blocked tool start", runtime.output);
	await waitUntil(
		() => runtime.output().includes("Agreed, with the condition"),
		"visible narration before tool release",
		runtime.output,
	);
	await runtime.terminal.flush();
	expectNarration(runtime);
	expect(probe.requests).toBe(1);
	expect(existsSync(join(probe.paths.tempDir, "tool-release"))).toBe(false);
}

async function verifySignedCompletion(probe: Probe): Promise<string> {
	const runtime = probe.runtime;
	if (!runtime) throw new Error("Narration PTY was not started");
	writeFileSync(join(probe.paths.tempDir, "tool-release"), "release");
	await waitUntil(() => probe.requests === 2, "completion request", runtime.output);
	const sessions = await SessionManager.list(probe.paths.workspaceDir, probe.paths.sessionDir);
	expect(sessions).toHaveLength(1);
	const sessionFile = sessions[0].path;
	await waitUntil(
		() =>
			SessionManager.open(sessionFile)
				.getBranch()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "end_turn",
				),
		"durable completion",
		runtime.output,
	);
	const recorded = SessionManager.open(sessionFile)
		.getBranch()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
	expect(recorded[0].content.slice(0, 2)).toEqual(fixture.content);
	expect(probe.replayedContent?.slice(0, 2)).toEqual(fixture.content);
	expect(recorded).toHaveLength(2);
	return sessionFile;
}

async function verifyReloadedNarration(probe: Probe, sessionFile: string): Promise<void> {
	if (!probe.runtime || !probe.provider) throw new Error("Narration probe was not started");
	await stopPty(probe.runtime);
	probe.provider.getSocket()?.destroy();
	probe.runtime = startPty(probe.paths, sessionFile);
	const runtime = probe.runtime;
	await waitUntil(() => runtime.output().includes("Agreed, with the condition"), "restored narration", runtime.output);
	await runtime.terminal.flush();
	expectNarration(runtime);
	expect(probe.requests).toBe(2);
}

async function cleanupProbe(probe: Probe): Promise<void> {
	if (probe.runtime) await stopPty(probe.runtime);
	probe.provider?.getSocket()?.destroy();
	if (probe.provider)
		await new Promise<void>((resolve, reject) =>
			probe.provider?.server.close((error) => (error ? reject(error) : resolve())),
		);
	rmSync(probe.paths.tempDir, { recursive: true, force: true });
}

it.skipIf(process.platform === "win32")(
	"shows captured narration before a blocked tool and after real CLI reload without regenerating it",
	async () => {
		const probe: Probe = { paths: createHeadlessPaths(), requests: 0 };
		await runWithCleanup(
			async () => {
				await startProbe(probe);
				await verifyLiveNarration(probe);
				const sessionFile = await verifySignedCompletion(probe);
				await verifyReloadedNarration(probe, sessionFile);
			},
			() => cleanupProbe(probe),
		);
	},
	60_000,
);
