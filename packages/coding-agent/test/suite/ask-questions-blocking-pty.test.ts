import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	cleanupHeadlessPiResources,
	createHeadlessPaths,
	createProviderServer,
	runWithCleanup,
} from "./headless-pi.ts";

const QUESTION = "Which regression target should we keep?";
const ANSWER = "Keep PTY coverage";
const FIXTURES = join(import.meta.dirname, "fixtures");
type Provider = Awaited<ReturnType<typeof createProviderServer>>;
type ProviderRequest = Parameters<Parameters<typeof createProviderServer>[1]>[0];
type Probe = {
	paths: ReturnType<typeof createHeadlessPaths>;
	provider?: Provider;
	bridge?: ChildProcessWithoutNullStreams;
	terminal: VirtualTerminal;
	requests: ProviderRequest[];
	output: string;
};

async function waitUntil(
	probe: Probe,
	predicate: () => boolean | Promise<boolean>,
	description: string,
): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(
		`Timed out waiting for ${description}; requests=${probe.requests.length}; PTY: ${probe.output.slice(-4000)}`,
	);
}

async function panelVisible(probe: Probe): Promise<boolean> {
	await probe.terminal.flush();
	const viewport = probe.terminal.getViewport().join("\n");
	return viewport.includes(QUESTION) && viewport.includes(ANSWER) && viewport.includes("Other");
}

function respond(probe: Probe, index: number, message: AssistantMessage): void {
	const request = probe.requests[index];
	const socket = probe.provider?.getSocket();
	if (!request || !socket) throw new Error(`Missing faux provider request ${index}`);
	socket.write(`${JSON.stringify({ type: "response", requestId: request.id, message })}\n`);
}

async function startProbe(probe: Probe): Promise<void> {
	writeFileSync(
		join(probe.paths.agentDir, "settings.json"),
		JSON.stringify({ approvalPolicy: "auto-approve", approvalPreset: "auto-approve" }),
	);
	probe.provider = await createProviderServer(probe.paths.socketPath, (request) => probe.requests.push(request));
	probe.bridge = spawn(
		"python3",
		[
			join(FIXTURES, "interactive-pty-bridge.py"),
			"32",
			"100",
			process.execPath,
			"--experimental-strip-types",
			"--import",
			pathToFileURL(join(FIXTURES, "interactive-pty-provider-preload.ts")).href,
			join(import.meta.dirname, "..", "..", "src", "cli.ts"),
			"--provider",
			"headless-faux",
			"--model",
			"headless-faux-1",
			"--session-dir",
			probe.paths.sessionDir,
			"--no-context-files",
			"--no-skills",
			"--no-themes",
			"--no-extensions",
			"--extension",
			join(FIXTURES, "interactive-pty-provider-extension.ts"),
		],
		{
			cwd: probe.paths.workspaceDir,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: probe.paths.agentDir,
				PI_CODING_AGENT_STATE_DIR: probe.paths.agentDir,
				PI_CODING_AGENT_SESSION_DIR: probe.paths.sessionDir,
				PI_HEADLESS_PROVIDER_SOCKET: probe.paths.socketPath,
				PI_TUI_WRITE_LOG: "",
				PI_DEBUG_REDRAW: "0",
				PI_TUI_DEBUG: "0",
				TERM: "xterm-256color",
				NO_COLOR: "1",
			},
		},
	);
	probe.bridge.stdout.setEncoding("utf8");
	probe.bridge.stdout.on("data", (chunk: string) => {
		probe.output += chunk;
		probe.terminal.write(chunk);
	});
	probe.bridge.stderr.on("data", (chunk: Buffer) => {
		probe.output += chunk.toString();
	});
	await waitUntil(probe, () => probe.output.includes("headless-faux-1"), "interactive startup");
	probe.bridge.stdin.write(
		"Ask which regression to keep, then write authorized-work.txt with independent work complete.\r",
	);
	await waitUntil(probe, () => probe.requests.length === 1, "initial model request");
}

async function stopBridge(bridge: ChildProcessWithoutNullStreams | undefined): Promise<void> {
	if (!bridge || bridge.exitCode !== null || bridge.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => bridge.once("close", () => resolve()));
	bridge.kill("SIGTERM");
	const stopped = await Promise.race([
		exited.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 2500)),
	]);
	if (!stopped) {
		bridge.kill("SIGKILL");
		await exited;
	}
}

function questionResults(request: ProviderRequest) {
	return request.messages.filter((message) => message.role === "toolResult" && message.toolName === "ask_questions");
}

async function readEntries(probe: Probe) {
	const sessions = await SessionManager.list(probe.paths.workspaceDir, probe.paths.sessionDir);
	expect(sessions).toHaveLength(1);
	return SessionManager.open(sessions[0].path).getEntries();
}

async function assertBlockingWaitThenAnswer(probe: Probe, workPath: string): Promise<void> {
	// Observe a bounded no-answer interval after the real panel has painted.
	await new Promise((resolve) => setTimeout(resolve, 500));
	expect(probe.requests).toHaveLength(1);
	expect(existsSync(workPath)).toBe(false);
	const entries = await readEntries(probe);
	expect(entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult")).toBe(false);
	probe.bridge?.stdin.write("\r");
}

async function readAndAssertQuestionResult(probe: Probe, blocking: boolean, requestId: string) {
	await waitUntil(probe, () => probe.requests.length === 2, "model continuation after ask_questions result");
	const results = questionResults(probe.requests[1]);
	expect(results).toHaveLength(1);
	if (blocking) {
		expect(JSON.stringify(results[0].content)).toContain(`${QUESTION} → ${ANSWER}`);
		return results;
	}

	expect(JSON.stringify(results[0].content)).toContain(`Questions queued (request ${requestId})`);
	const queuedResults = (await readEntries(probe)).flatMap((entry) =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ask_questions"
			? [entry.message]
			: [],
	);
	expect(queuedResults).toHaveLength(1);
	expect(queuedResults[0].details).toMatchObject({
		queued: true,
		requestId,
		blocking: false,
		answers: {},
		cancelled: false,
	});
	expect(JSON.stringify(results[0].content)).not.toContain(`${QUESTION} → ${ANSWER}`);
	expect(await panelVisible(probe)).toBe(true);
	return results;
}

async function writeAndAssertAuthorizedWork(probe: Probe, workPath: string): Promise<void> {
	respond(
		probe,
		1,
		fauxAssistantMessage(fauxToolCall("write", { path: workPath, content: "independent work complete" }), {
			stopReason: "toolUse",
		}),
	);
	await waitUntil(probe, () => probe.requests.length === 3, "model sees authorized write completion");
	expect(readFileSync(workPath, "utf8")).toBe("independent work complete");
}

async function answerQueuedPanelDuringProviderRequest(probe: Probe): Promise<void> {
	expect(await panelVisible(probe)).toBe(true);
	expect(
		probe.requests[2].messages.some(
			(message) => message.role === "user" && JSON.stringify(message.content).includes(ANSWER),
		),
	).toBe(false);
	// Enter arrives while the next faux model request is live, not after agent completion.
	probe.bridge?.stdin.write("\r");
	await waitUntil(probe, async () => !(await panelVisible(probe)), "Enter closes queued panel");
}

async function assertDurableInboxThenRespond(
	probe: Probe,
	requestId: string,
	originalResults: ReturnType<typeof questionResults>,
): Promise<void> {
	await waitUntil(probe, () => probe.requests.length === 4, "answer delivered to originating agent inbox");
	const delivered = probe.requests[3];
	const inboxPrefix = `User answered questions (request ${requestId}):`;
	const inbox = delivered.messages.filter(
		(message) => message.role === "user" && JSON.stringify(message.content).includes(inboxPrefix),
	);
	expect(inbox, JSON.stringify(delivered.messages)).toHaveLength(1);
	expect(JSON.stringify(inbox[0].content)).toContain(`${QUESTION} → ${ANSWER}`);
	expect(questionResults(delivered)).toEqual(originalResults);
	await waitUntil(
		probe,
		async () =>
			(await readEntries(probe)).some((entry) => {
				if (entry.type !== "message" || entry.message.role !== "user") return false;
				const containsAnswer = JSON.stringify(entry.message.content).includes(inboxPrefix);
				const hasMailboxIdentity = (entry.mailboxStoreRefs?.length ?? 0) > 0;
				return containsAnswer && hasMailboxIdentity;
			}),
		"durable inbox acceptance with mailbox identity",
	);
	respond(
		probe,
		3,
		fauxAssistantMessage(
			[
				{ type: "text", text: "Inbox answer received." },
				fauxToolCall("end_turn", { reason: "Question answer acknowledged" }),
			],
			{ stopReason: "toolUse" },
		),
	);
}

it.skipIf(process.platform === "win32").each([false, true])(
	"real PTY honors ask_questions blocking=%s across model work and Enter answer delivery",
	async (blocking) => {
		const probe: Probe = {
			paths: createHeadlessPaths(),
			terminal: new VirtualTerminal(100, 32),
			requests: [],
			output: "",
		};
		await runWithCleanup(
			async () => {
				await startProbe(probe);
				const call = fauxToolCall("ask_questions", {
					blocking,
					questions: [{ question: QUESTION, options: [{ label: ANSWER }, { label: "Drop PTY coverage" }] }],
				});
				respond(probe, 0, fauxAssistantMessage(call, { stopReason: "toolUse" }));
				await waitUntil(probe, () => panelVisible(probe), "question panel awaiting actual keyboard input");
				const workPath = join(probe.paths.workspaceDir, "authorized-work.txt");

				if (blocking) await assertBlockingWaitThenAnswer(probe, workPath);
				const results = await readAndAssertQuestionResult(probe, blocking, call.id);
				await writeAndAssertAuthorizedWork(probe, workPath);
				if (!blocking) await answerQueuedPanelDuringProviderRequest(probe);
				respond(
					probe,
					2,
					fauxAssistantMessage(
						[
							{ type: "text", text: "Independent work completed." },
							fauxToolCall("end_turn", { reason: "Authorized independent work completed" }),
						],
						{ stopReason: "toolUse" },
					),
				);

				if (!blocking) await assertDurableInboxThenRespond(probe, call.id, results);
				const finalText = blocking ? "Independent work completed." : "Inbox answer received.";
				await waitUntil(
					probe,
					async () =>
						(await readEntries(probe)).some(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "assistant" &&
								entry.message.content.some((block) => block.type === "text" && block.text === finalText),
						),
					"final faux response persisted before process cleanup",
				);
			},
			() =>
				cleanupHeadlessPiResources({
					stopClient: () => stopBridge(probe.bridge),
					destroyProviderSocket: () => probe.provider?.getSocket()?.destroy(),
					closeProviderServer: () =>
						probe.provider
							? new Promise<void>((resolve, reject) =>
									probe.provider?.server.close((error) => (error ? reject(error) : resolve())),
								)
							: Promise.resolve(),
					removeTempDir: () => rmSync(probe.paths.tempDir, { recursive: true, force: true }),
				}),
		);
	},
	45_000,
);
