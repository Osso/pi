import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type TextContent,
	type ThinkingContent,
} from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import {
	enqueueStoredRuntimeMailboxMessage,
	getControlDbPath,
	readRuntimeMailboxMessage,
} from "../../../src/core/session-control-db.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import {
	cleanupHeadlessPiResources,
	createHeadlessPaths,
	createProviderServer,
	runWithCleanup,
} from "../headless-pi.ts";

// Only captured public blocks: no unrelated transcript, credentials, or /var/tmp dependency.
const captured = JSON.parse(
	readFileSync(new URL("../../fixtures/anthropic-fast-narration.json", import.meta.url), "utf8"),
) as { replies: Array<{ entryId: string; content: ThinkingContent[] }> };
const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const MAILBOX_BODY = "Real runtime mailbox arrived while fast narration response was pending";
type Scenario = {
	name: string;
	content: Array<TextContent | ThinkingContent>;
	separateEnd: boolean;
};
type Paths = ReturnType<typeof createHeadlessPaths>;
type Provider = Awaited<ReturnType<typeof createProviderServer>>;
type Request = Parameters<Parameters<typeof createProviderServer>[1]>[0];
type Probe = {
	paths: Paths;
	proofDir: string;
	provider?: Provider;
	process?: ChildProcessWithoutNullStreams;
	terminal: VirtualTerminal;
	output: string;
	lastOutputAt: number;
	requests: Request[];
	events: Array<{ at: string; event: string; detail?: unknown }>;
	sessionFile?: string;
};

function record(probe: Probe, event: string, detail?: unknown): void {
	probe.events.push({ at: new Date().toISOString(), event, detail });
}

async function waitUntil(probe: Probe, predicate: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		if (probe.process?.exitCode !== null && probe.process?.exitCode !== undefined)
			throw new Error(`PTY exited while waiting for ${description}: ${probe.output.slice(-4000)}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${description}; proof: ${probe.proofDir}\n${probe.output.slice(-4000)}`);
}

function readSessionBranch(probe: Probe) {
	if (!probe.sessionFile) throw new Error("PTY session file not found");
	return SessionManager.open(probe.sessionFile).getBranch();
}

async function waitForRenderedCompletion(probe: Probe, toolCallId: string): Promise<void> {
	await waitUntil(
		probe,
		() =>
			readSessionBranch(probe).some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === toolCallId,
			),
		`durable end_turn ${toolCallId}`,
	);
	record(probe, "durable-end-turn", toolCallId);
	// Persistence precedes the PTY's asynchronous delivery and throttled redraw.
	// Wait for output quiescence, NOT for the expected prose (which could have been erased).
	await waitUntil(probe, () => Date.now() - probe.lastOutputAt >= 100, "post-completion PTY quiescence");
	await probe.terminal.flush();
}

async function startProbe(probe: Probe): Promise<void> {
	writeFileSync(
		join(probe.paths.agentDir, "settings.json"),
		JSON.stringify({
			approvalPolicy: "auto-approve",
			approvalPreset: "auto-approve",
			hideThinkingBlock: true,
			enableInstallTelemetry: false,
		}),
	);
	probe.provider = await createProviderServer(probe.paths.socketPath, (request) => {
		probe.requests.push(request);
		record(probe, "provider-request", { id: request.id, messages: request.messages });
	});
	const executable = process.env.PI_TEST_NARRATION_EXECUTABLE;
	const launch = executable
		? [executable]
		: [process.execPath, "--experimental-strip-types", join(import.meta.dirname, "..", "..", "..", "src", "cli.ts")];
	record(probe, "runtime-launch", launch);
	probe.process = spawn(
		"python3",
		[
			join(FIXTURES, "interactive-pty-bridge.py"),
			"24",
			"80",
			...launch,
			"--offline",
			"--provider",
			"headless-faux",
			"--model",
			"headless-faux-1",
			"--name",
			"fast narration diagnostic",
			"--no-context-files",
			"--no-skills",
			"--no-themes",
			"--no-extensions",
			"--session-dir",
			probe.paths.sessionDir,
			"--extension",
			join(FIXTURES, "interactive-narration-provider.ts"),
		],
		{
			cwd: probe.paths.workspaceDir,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: probe.paths.agentDir,
				PI_CODING_AGENT_STATE_DIR: probe.paths.agentDir,
				PI_CODING_AGENT_SESSION_DIR: probe.paths.sessionDir,
				PI_HEADLESS_PROVIDER_SOCKET: probe.paths.socketPath,
				PI_OFFLINE: "1",
				PI_TUI_WRITE_LOG: "",
				PI_DEBUG_REDRAW: "0",
				PI_TUI_DEBUG: "0",
				TERM: "xterm-256color",
				NO_COLOR: "1",
			},
		},
	);
	probe.process.stdout.setEncoding("utf8");
	probe.process.stdout.on("data", (chunk: string) => {
		probe.output += chunk;
		probe.lastOutputAt = Date.now();
		probe.terminal.write(chunk);
	});
	probe.process.stderr.on("data", (chunk: Buffer) => {
		probe.output += chunk.toString();
	});
	await waitUntil(probe, () => probe.output.includes("headless-faux-1"), "interactive startup");
}

function respond(probe: Probe, request: Request, message: AssistantMessage): void {
	record(probe, "provider-response", { requestId: request.id, content: message.content });
	const socket = probe.provider?.getSocket();
	if (!socket) throw new Error("PTY faux provider is disconnected");
	socket.write(`${JSON.stringify({ type: "response", requestId: request.id, message })}\n`);
}

function assertPublicProse(probe: Probe, expected: string[], checkpoint: string): void {
	const rendered = probe.terminal.getScrollBuffer().join("\n");
	record(probe, "rendered-checkpoint", { checkpoint, rendered });
	const counts = new Map<string, number>();
	for (const prose of expected) {
		const normalized = prose.replace(/\s+/g, " ").trim();
		counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
	}
	for (const [prose, count] of counts) {
		// Identical controls must not mask a later missing signed response.
		expect(
			rendered.replace(/\s+/g, " ").split(prose).length - 1,
			`${checkpoint}; ${prose}; proof: ${probe.proofDir}`,
		).toBe(count);
	}
}

async function stopPty(probe: Probe): Promise<void> {
	const child = probe.process;
	if (!child) return;
	const hasExited = child.exitCode !== null || child.signalCode !== null;
	if (hasExited) return;
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.kill("SIGTERM");
	const stopped = await Promise.race([
		closed.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 2500)),
	]);
	if (!stopped) {
		child.kill("SIGKILL");
		await closed;
	}
}

async function cleanup(probe: Probe): Promise<void> {
	// Keep bounded incident proof outside the disposable runtime, even on assertion failure.
	await probe.terminal.flush();
	writeFileSync(join(probe.proofDir, "events.json"), JSON.stringify(probe.events, null, 2));
	writeFileSync(join(probe.proofDir, "output.ansi"), probe.output);
	writeFileSync(join(probe.proofDir, "scrollback.txt"), probe.terminal.getScrollBuffer().join("\n"));
	if (probe.sessionFile) writeFileSync(join(probe.proofDir, "session.jsonl"), readFileSync(probe.sessionFile));
	console.info(`Fast narration diagnostic artifacts: ${probe.proofDir}`);
	await cleanupHeadlessPiResources({
		stopClient: () => stopPty(probe),
		destroyProviderSocket: () => probe.provider?.getSocket()?.destroy(),
		closeProviderServer: async () => {
			if (probe.provider)
				await new Promise<void>((resolve, reject) =>
					probe.provider?.server.close((error) => (error ? reject(error) : resolve())),
				);
		},
		removeTempDir: () => rmSync(probe.paths.tempDir, { recursive: true, force: true }),
	});
}

function enqueuePendingMailbox(probe: Probe, request: Request, label: string): void {
	if (!request.sessionId) throw new Error("Provider request lacks recipient session ID");
	const mailboxId = enqueueStoredRuntimeMailboxMessage(getControlDbPath(probe.paths.agentDir), {
		kind: "message",
		recipient: { sessionId: request.sessionId, agentId: null },
		sender: { sessionId: "fast-narration-sender", agentId: null },
		storeRef: { sessionPath: join(probe.paths.tempDir, "sender.jsonl"), messageId: label },
		message: {
			id: label,
			kind: "message",
			fromAgentId: "main",
			toAgentId: "main",
			status: "pending",
			body: MAILBOX_BODY,
			createdAt: new Date().toISOString(),
		},
	});
	expect(readRuntimeMailboxMessage(getControlDbPath(probe.paths.agentDir), mailboxId)?.status).toBe("pending");
	record(probe, "mailbox-persisted-before-response", mailboxId);
}

async function respondToScenario(
	probe: Probe,
	scenario: Scenario,
	requestIndex: number,
	end: ReturnType<typeof fauxToolCall>,
): Promise<void> {
	respond(
		probe,
		probe.requests[requestIndex],
		fauxAssistantMessage([...structuredClone(scenario.content), ...(scenario.separateEnd ? [] : [end])], {
			stopReason: scenario.separateEnd ? "stop" : "toolUse",
		}),
	);
	if (!scenario.separateEnd) return;
	await waitUntil(probe, () => probe.requests.length > requestIndex + 1, "separate end_turn request");
	respond(probe, probe.requests[requestIndex + 1], fauxAssistantMessage(end, { stopReason: "toolUse" }));
}

async function discoverSessionFile(probe: Probe): Promise<void> {
	if (probe.sessionFile) return;
	await waitUntil(
		probe,
		() => readdirSync(probe.paths.sessionDir).some((name) => name.endsWith(".jsonl")),
		"first response persistence",
	);
	const sessions = await SessionManager.list(probe.paths.workspaceDir, probe.paths.sessionDir);
	expect(sessions).toHaveLength(1);
	probe.sessionFile = sessions[0].path;
}

function assertPersistedScenario(probe: Probe, scenario: Scenario, toolCallId: string): void {
	const recorded = readSessionBranch(probe).find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
	);
	if (scenario.separateEnd) return;
	expect(
		recorded?.type === "message" && recorded.message.role === "assistant" && recorded.message.content.slice(0, -1),
	).toEqual(scenario.content);
}

async function completeMailboxFollowup(
	probe: Probe,
	requestIndex: number,
	toolCallId: string,
	expected: string[],
): Promise<void> {
	await waitUntil(probe, () => probe.requests.length > requestIndex + 1, "mailbox follow-up request");
	const followup = probe.requests[requestIndex + 1];
	expect(JSON.stringify(followup.messages)).toContain(MAILBOX_BODY);
	const entries = readSessionBranch(probe);
	const endIndex = entries.findIndex(
		(entry) =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId,
	);
	const mailboxIndex = entries.findIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			JSON.stringify(entry.message.content).includes(MAILBOX_BODY),
	);
	expect(mailboxIndex).toBeGreaterThan(endIndex);
	record(probe, "mailbox-accepted-after-end-turn", { endIndex, mailboxIndex });
	assertPublicProse(probe, expected, "after mailbox acceptance before response");
	const mailboxEnd = fauxToolCall("end_turn", { reason: "Mailbox processed" }, { id: "mailbox-end" });
	respond(probe, followup, fauxAssistantMessage(mailboxEnd, { stopReason: "toolUse" }));
	await waitForRenderedCompletion(probe, mailboxEnd.id);
	assertPublicProse(probe, expected, "after mailbox completion");
}

async function runScenario(probe: Probe, scenario: Scenario, round: number, expected: string[]): Promise<void> {
	const label = `${round}-${scenario.name}`;
	const requestIndex = probe.requests.length;
	probe.process?.stdin.write(`Fast completion probe ${label}\r`);
	await waitUntil(probe, () => probe.requests.length > requestIndex, `request ${label}`);
	const withMailbox = round === 1 && scenario.name === "230e5966";
	if (withMailbox) enqueuePendingMailbox(probe, probe.requests[requestIndex], label);
	const end = fauxToolCall("end_turn", { reason: `Completed ${label}` }, { id: `end-${label}` });
	await respondToScenario(probe, scenario, requestIndex, end);
	await discoverSessionFile(probe);
	await waitForRenderedCompletion(probe, end.id);
	const publicText = scenario.content.map((block) => (block.type === "text" ? block.text : block.thinking)).join("\n");
	expected.push(publicText);
	assertPersistedScenario(probe, scenario, end.id);
	assertPublicProse(probe, expected, `completed ${label}`);
	if (withMailbox) {
		await completeMailboxFollowup(probe, requestIndex, end.id, expected);
		return;
	}
	expect(probe.requests).toHaveLength(requestIndex + (scenario.separateEnd ? 2 : 1));
}

it.skipIf(process.platform === "win32")(
	"retains public prose through repeated fast end_turn completions and a real mid-turn mailbox arrival",
	async () => {
		const probe: Probe = {
			paths: createHeadlessPaths(),
			proofDir: mkdtempSync(join(tmpdir(), "pi-fast-narration-proof-")),
			terminal: new VirtualTerminal(80, 24),
			output: "",
			lastOutputAt: Date.now(),
			requests: [],
			events: [],
		};
		await runWithCleanup(
			async () => {
				await startProbe(probe);
				const expected: string[] = [];
				// Controls use identical prose; no new model-generated summary substitutes for signed blocks.
				const cases: Scenario[] = [
					{
						name: "ordinary-same-response",
						content: [{ type: "text" as const, text: captured.replies[0].content[0].thinking }],
						separateEnd: false,
					},
					{
						name: "ordinary-separate-end",
						content: [{ type: "text" as const, text: captured.replies[1].content[0].thinking }],
						separateEnd: true,
					},
					...captured.replies.map((reply) => ({
						name: reply.entryId,
						content: reply.content,
						separateEnd: false,
					})),
				];
				for (let round = 0; round < 2; round++) {
					for (const scenario of cases) {
						await runScenario(probe, scenario, round, expected);
					}
				}
			},
			() => cleanup(probe),
		);
	},
	90_000,
);
