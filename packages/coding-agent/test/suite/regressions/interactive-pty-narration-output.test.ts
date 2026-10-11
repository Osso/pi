import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AssistantMessage,
	type ThinkingContent,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHeadlessPaths, createProviderServer, runWithCleanup } from "../headless-pi.ts";

const fixture = JSON.parse(
	readFileSync(new URL("../../fixtures/anthropic-narration.json", import.meta.url), "utf8"),
) as { content: ThinkingContent[] };

type PtyRuntime = {
	process: ChildProcessWithoutNullStreams;
	terminal: VirtualTerminal;
	output: () => string;
};

async function waitUntil(predicate: () => boolean, description: string, output: () => string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}: ${output().slice(-4000)}`);
}

function startPty(paths: ReturnType<typeof createHeadlessPaths>, sessionFile?: string): PtyRuntime {
	const fixtures = join(import.meta.dirname, "..", "fixtures");
	const processHandle = spawn(
		"python3",
		[
			join(fixtures, "interactive-pty-bridge.py"),
			"24",
			"80",
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
			"--extension",
			join(fixtures, "interactive-narration-wait.ts"),
			...(sessionFile ? ["--session", sessionFile] : []),
		],
		{
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
		},
	);
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
	]) {
		expect(screen, runtime.output()).toContain(excerpt);
	}
	expect(screen).not.toContain("I lean toward yes, batching makes sense");
}

it.skipIf(process.platform === "win32")(
	"shows captured narration before a blocked tool and after real CLI reload without regenerating it",
	async () => {
		const paths = createHeadlessPaths();
		writeFileSync(
			join(paths.agentDir, "settings.json"),
			JSON.stringify({
				approvalPolicy: "auto-approve",
				approvalPreset: "auto-approve",
				hideThinkingBlock: true,
			}),
		);
		let runtime: PtyRuntime | undefined;
		let provider: Awaited<ReturnType<typeof createProviderServer>> | undefined;
		let requests = 0;
		let replayedContent: AssistantMessage["content"] | undefined;
		await runWithCleanup(
			async () => {
				provider = await createProviderServer(paths.socketPath, (request) => {
					requests++;
					if (requests === 2)
						replayedContent = request.messages.find((message) => message.role === "assistant")?.content;
					const response =
						requests === 1
							? fauxAssistantMessage([...structuredClone(fixture.content), fauxToolCall("narration_wait", {})], {
									stopReason: "toolUse",
								})
							: fauxAssistantMessage(fauxToolCall("end_turn", { reason: "Done" }), { stopReason: "toolUse" });
					provider
						?.getSocket()
						?.write(`${JSON.stringify({ type: "response", requestId: request.id, message: response })}\n`);
				});
				runtime = startPty(paths);
				const first = runtime;
				await waitUntil(() => first.output().includes("headless-faux-1"), "interactive startup", first.output);
				first.process.stdin.write("Opinion on batching full suites?\r");
				await waitUntil(() => existsSync(join(paths.tempDir, "tool-started")), "blocked tool start", first.output);
				await waitUntil(
					() => first.output().includes("Agreed, with the condition"),
					"visible narration before tool release",
					first.output,
				);
				await first.terminal.flush();
				expectNarration(first);
				expect(requests).toBe(1);
				expect(existsSync(join(paths.tempDir, "tool-release"))).toBe(false);
				writeFileSync(join(paths.tempDir, "tool-release"), "release");
				await waitUntil(() => requests === 2, "completion request", first.output);
				const sessions = await SessionManager.list(paths.workspaceDir, paths.sessionDir);
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
					first.output,
				);
				const recorded = SessionManager.open(sessionFile)
					.getBranch()
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
					);
				expect(recorded[0].content.slice(0, 2)).toEqual(fixture.content);
				expect(replayedContent?.slice(0, 2)).toEqual(fixture.content);
				expect(recorded).toHaveLength(2);
				await stopPty(first);
				provider.getSocket()?.destroy();
				runtime = startPty(paths, sessionFile);
				const resumed = runtime;
				await waitUntil(
					() => resumed.output().includes("Agreed, with the condition"),
					"restored narration",
					resumed.output,
				);
				await resumed.terminal.flush();
				expectNarration(resumed);
				expect(requests).toBe(2);
			},
			async () => {
				if (runtime) await stopPty(runtime);
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
