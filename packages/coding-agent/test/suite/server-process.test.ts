import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { type HeadlessPi, withHeadlessPi } from "./headless-pi.ts";

type Frame = Record<string, unknown>;

const FOREIGN_SUPERVISOR_HOST = `${hostname()}-remote-supervisor`;

class ServerClient {
	private readonly lines: ReturnType<typeof createInterface>;
	readonly socket: Socket;
	private readonly pending = new Map<string, (frame: Frame) => void>();
	private readonly events: Frame[] = [];
	private requestId = 0;

	constructor(socket: Socket) {
		this.socket = socket;
		this.lines = createInterface({ input: socket, crlfDelay: Infinity });
		this.lines.on("line", (line) => {
			const frame = JSON.parse(line) as Frame;
			if (frame.type === "response" && typeof frame.id === "string") {
				this.pending.get(frame.id)?.(frame);
				this.pending.delete(frame.id);
			} else this.events.push(frame);
		});
	}

	static async connect(path: string): Promise<ServerClient> {
		const socket = createConnection(path);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		return new ServerClient(socket);
	}

	request(type: string, fields: Frame = {}): Promise<Frame> {
		const id = `test-${++this.requestId}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${type}`));
			}, 30_000);
			this.pending.set(id, (frame) => {
				clearTimeout(timeout);
				resolve(frame);
			});
			this.socket.write(`${JSON.stringify({ id, type, ...fields })}\n`);
		});
	}

	close(): void {
		this.lines.close();
		this.socket.destroy();
	}

	async waitForEvent(predicate: (event: Frame) => boolean): Promise<Frame> {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const event = this.events.find(predicate);
			if (event) return event;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("Timed out waiting for server event");
	}
}

async function startDaemon(
	agent: HeadlessPi,
	supervisorHost: string | null = FOREIGN_SUPERVISOR_HOST,
): Promise<{ daemon: ChildProcess; client: ServerClient; runtimeDir: string }> {
	const runtimeDir = join(agent.paths.tempDir, "runtime");
	mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const socketPath = join(runtimeDir, "pi", "server.sock");
	const cliPath = join(import.meta.dirname, "../../src/cli.ts");
	const preloadPath = join(import.meta.dirname, "fixtures/headless-pi-provider-preload.ts");
	const settings = SettingsManager.create(agent.paths.workspaceDir, agent.paths.agentDir, { projectTrusted: true });
	settings.setDefaultModelAndProvider("headless-faux", "headless-faux-1");
	const settingsPath = join(agent.paths.agentDir, "settings.json");
	const storedSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	if (supervisorHost !== null) storedSettings.supervisor = { host: supervisorHost, sessionId: "remote-supervisor" };
	else delete storedSettings.supervisor;
	writeFileSync(settingsPath, JSON.stringify(storedSettings));
	const { daemon, stderr } = spawnDaemon(agent, runtimeDir, preloadPath, cliPath);
	// Connect, not just check the file: a crashed server's stale socket file exists before the new server binds.
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (daemon.exitCode !== null) throw new Error(`pi server exited: ${stderr()}`);
		if (existsSync(socketPath)) {
			try {
				return { daemon, client: await ServerClient.connect(socketPath), runtimeDir };
			} catch {
				// Not listening yet.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`pi server did not accept connections: ${stderr()}`);
}

function spawnDaemon(
	agent: HeadlessPi,
	runtimeDir: string,
	preloadPath: string,
	cliPath: string,
): { daemon: ChildProcess; stderr: () => string } {
	const daemon = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--import",
			pathToFileURL(preloadPath).href,
			...process.execArgv,
			cliPath,
			"server",
		],
		{
			cwd: agent.paths.workspaceDir,
			env: {
				...process.env,
				XDG_RUNTIME_DIR: runtimeDir,
				PI_CODING_AGENT_DIR: agent.paths.agentDir,
				PI_CODING_AGENT_STATE_DIR: agent.paths.agentDir,
				PI_CODING_AGENT_SESSION_DIR: agent.paths.sessionDir,
				PI_HEADLESS_PROVIDER_SOCKET: join(agent.paths.tempDir, "provider.sock"),
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	daemon.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	return { daemon, stderr: () => stderr };
}

function stopDaemon(daemon: ChildProcess, runtimeDir: string): Promise<void> {
	if (daemon.exitCode !== null) {
		rmSync(runtimeDir, { recursive: true, force: true });
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		daemon.once("exit", () => {
			rmSync(runtimeDir, { recursive: true, force: true });
			resolve();
		});
		daemon.kill("SIGTERM");
	});
}

async function list(client: ServerClient): Promise<Frame[]> {
	const response = await client.request("list_sessions", { includeEnded: true });
	if (response.success !== true) throw new Error(JSON.stringify(response.error));
	return (response.data as { sessions: Frame[] }).sessions;
}

describe("pi server process", () => {
	it("forwards hello and list_sessions through the stdio connector", async () => {
		await withHeadlessPi(async (agent) => {
			const { daemon, client, runtimeDir } = await startDaemon(agent, null);
			client.close();
			const cliPath = join(import.meta.dirname, "../../src/cli.ts");
			const connector = spawn(
				process.execPath,
				["--experimental-strip-types", ...process.execArgv, cliPath, "server", "--stdio"],
				{
					cwd: agent.paths.workspaceDir,
					env: {
						...process.env,
						XDG_RUNTIME_DIR: runtimeDir,
						PI_CODING_AGENT_DIR: agent.paths.agentDir,
						PI_CODING_AGENT_STATE_DIR: agent.paths.agentDir,
						PI_CODING_AGENT_SESSION_DIR: agent.paths.sessionDir,
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			const stdout = connector.stdout;
			if (!stdout) throw new Error("stdio connector stdout is not piped");
			const lines = createInterface({ input: stdout, crlfDelay: Infinity });
			const pending = new Map<string, (frame: Frame) => void>();
			lines.on("line", (line) => {
				const frame = JSON.parse(line) as Frame;
				if (typeof frame.id === "string") pending.get(frame.id)?.(frame);
				if (typeof frame.id === "string") pending.delete(frame.id);
			});
			const request = (id: string, type: string, fields: Frame = {}) =>
				new Promise<Frame>((resolve, reject) => {
					const timeout = setTimeout(() => {
						pending.delete(id);
						reject(new Error(`Timed out waiting for stdio ${type}`));
					}, 10_000);
					pending.set(id, (frame) => {
						clearTimeout(timeout);
						resolve(frame);
					});
					connector.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
				});
			try {
				const hello = await request("stdio-hello", "hello", { version: 1 });
				expect(hello).toMatchObject({ type: "response", command: "hello", success: true });
				const helloData = hello.data as Frame;
				expect(helloData.questionStoreHost).toBe(helloData.hostId);
				const sessions = await request("stdio-sessions", "list_sessions", { includeEnded: true });
				expect(sessions).toMatchObject({ type: "response", command: "list_sessions", success: true });
				expect((sessions.data as { sessions: Frame[] }).sessions).toContainEqual(
					expect.objectContaining({ sessionId: agent.sessionId }),
				);
				const unknownCommand = await request("stdio-unknown", "toString");
				expect(unknownCommand).toMatchObject({
					success: false,
					error: { code: "unknown_command" },
				});
			} finally {
				connector.stdin?.end();
				lines.close();
				if (connector.exitCode === null) {
					await new Promise<void>((resolve) => connector.once("exit", () => resolve()));
				}
				await stopDaemon(daemon, runtimeDir);
			}
		});
	}, 60_000);

	it("restarts over a stale socket, refuses a live one, and releases a worker that exits on its own", async () => {
		await withHeadlessPi(async (agent) => {
			const first = await startDaemon(agent, null);
			first.client.close();
			// A second daemon must not take over a socket that a running server answers on.
			const second = spawnDaemon(
				agent,
				first.runtimeDir,
				join(import.meta.dirname, "fixtures/headless-pi-provider-preload.ts"),
				join(import.meta.dirname, "../../src/cli.ts"),
			);
			const secondExit = await new Promise<number | null>((resolve) => second.daemon.once("exit", resolve));
			expect(secondExit).not.toBe(0);
			expect(second.stderr()).toMatch(/already running/);
			// SIGKILL leaves the socket file behind, as a crash would.
			await new Promise<void>((resolve) => {
				first.daemon.once("exit", () => resolve());
				first.daemon.kill("SIGKILL");
			});
			expect(existsSync(join(first.runtimeDir, "pi", "server.sock"))).toBe(true);
			const { daemon, client, runtimeDir } = await startDaemon(agent, null);
			try {
				const started = await client.request("start_session", { cwd: agent.paths.workspaceDir });
				if (started.success !== true) throw new Error(JSON.stringify(started));
				const session = (started.data as { session: Frame }).session;
				const sessionId = session.sessionId as string;
				// A session stopped before any prompt still reports its ended summary.
				const empty = await client.request("start_session", { cwd: agent.paths.workspaceDir });
				if (empty.success !== true) throw new Error(JSON.stringify(empty));
				const emptySession = (empty.data as { session: Frame }).session;
				expect(
					await client.request("stop_session", {
						sessionId: emptySession.sessionId,
						runtimeInstanceId: emptySession.runtimeInstanceId,
					}),
				).toMatchObject({
					success: true,
					data: { session: { sessionId: emptySession.sessionId, status: "ended" } },
				});
				const workerPids = readFileSync(`/proc/${daemon.pid}/task/${daemon.pid}/children`, "utf8")
					.trim()
					.split(/\s+/)
					.map(Number);
				for (const pid of workerPids) process.kill(pid, "SIGKILL");
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline) {
					const owned = (await list(client)).some(
						(entry) => entry.sessionId === sessionId && entry.owner === "server",
					);
					if (!owned) break;
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				expect(await list(client)).not.toContainEqual(expect.objectContaining({ sessionId, owner: "server" }));
				const stopped = await client.request("stop_session", {
					sessionId,
					runtimeInstanceId: session.runtimeInstanceId,
				});
				expect(stopped).toMatchObject({ success: false, error: { code: "not_managed" } });
			} finally {
				client.close();
				await stopDaemon(daemon, runtimeDir);
			}
		});
	}, 90_000);

	it("starts, attaches, streams, reconnects, answers questions, lists external sessions, and stops workers", async () => {
		await withHeadlessPi(async (agent) => {
			const { daemon, client, runtimeDir } = await startDaemon(agent);
			try {
				expect(statSync(join(runtimeDir, "pi")).mode & 0o777).toBe(0o700);
				expect(statSync(join(runtimeDir, "pi", "server.sock")).mode & 0o777).toBe(0o600);
				const hello = await client.request("hello", { version: 1 });
				expect(hello).toMatchObject({
					success: true,
					data: { questionStoreHost: FOREIGN_SUPERVISOR_HOST },
				});
				const foreignQuestion = await client.request("answer_question", {
					questionId: "a999",
					answers: { question: "answer" },
				});
				expect(foreignQuestion).toMatchObject({
					success: false,
					error: { code: "not_found", message: expect.stringContaining(FOREIGN_SUPERVISOR_HOST) },
				});
				const initialSessions = await list(client);
				expect(initialSessions).toContainEqual(
					expect.objectContaining({ sessionId: agent.sessionId, owner: "external" }),
				);

				const started = await client.request("start_session", {
					cwd: agent.paths.workspaceDir,
					name: "server-test",
				});
				if (started.success !== true) throw new Error(JSON.stringify(started));
				const { session } = started.data as { session: Frame };
				const sessionId = session.sessionId as string;
				const runtimeInstanceId = session.runtimeInstanceId as string;
				const attached = await client.request("attach_session", { sessionId, mode: "control" });
				expect(attached.success).toBe(true);
				const snapshot = attached.data as { runtimeInstanceId: string; snapshot: Frame };
				expect(snapshot.runtimeInstanceId).toBe(runtimeInstanceId);

				const prompt = client.request("session_rpc", {
					sessionId,
					runtimeInstanceId,
					command: { type: "prompt", id: "prompt-inner", message: "Describe the server test." },
				});
				await prompt;
				const request = await agent.waitForLlmRequest((item) =>
					item.userMessages.includes("Describe the server test."),
				);
				agent.respondToLlmRequest(
					request.id,
					fauxAssistantMessage(
						[
							{ type: "text", text: "Server test complete." },
							fauxToolCall("end_turn", { reason: "Server test complete" }),
						],
						{ stopReason: "toolUse" },
					),
				);
				await client.waitForEvent(
					(event) =>
						event.type === "session_event" &&
						event.sessionId === sessionId &&
						(event.event as Frame | undefined)?.type === "agent_end",
				);
				await client.request("detach_session", { sessionId, runtimeInstanceId });
				client.close();

				const reconnected = await ServerClient.connect(join(runtimeDir, "pi", "server.sock"));
				try {
					const afterDisconnect = await list(reconnected);
					expect(afterDisconnect).toContainEqual(
						expect.objectContaining({ sessionId, owner: "server", status: expect.any(String) }),
					);
					const reattached = await reconnected.request("attach_session", { sessionId, mode: "control" });
					expect(reattached.success).toBe(true);
					const restoredSnapshot = (reattached.data as { snapshot: Frame }).snapshot;
					expect(JSON.stringify(restoredSnapshot.get_messages)).toContain("Describe the server test.");

					const questionRpc = reconnected.request("session_rpc", {
						sessionId,
						runtimeInstanceId,
						command: { type: "prompt", message: "Ask the operator for a value." },
					});
					await questionRpc;
					const questionRequest = await agent.waitForLlmRequest((item) =>
						item.userMessages.includes("Ask the operator for a value."),
					);
					agent.respondToLlmRequest(
						questionRequest.id,
						fauxAssistantMessage(
							[
								fauxToolCall("ask_questions", {
									blocking: true,
									questions: [{ question: "Which value should I use?" }],
								}),
							],
							{ stopReason: "toolUse" },
						),
					);
					await reconnected.waitForEvent(
						(event) =>
							event.type === "session_event" &&
							(event.event as Frame | undefined)?.type === "extension_ui_request" &&
							(event.event as Frame | undefined)?.method === "questions",
					);
					const inbox = await reconnected.request("list_questions");
					const questions = (inbox.data as { questions: Frame[] }).questions;
					const directQuestion = questions.find(
						(entry) => entry.sessionId === sessionId && entry.state === "pending",
					);
					expect(directQuestion).toMatchObject({
						blocking: true,
						toolCallId: expect.any(String),
						answerable: true,
					});
					const answer = await reconnected.request("answer_question", {
						questionId: directQuestion?.questionId,
						answers: { "Which value should I use?": "42" },
					});
					expect(answer).toMatchObject({ success: true, data: { delivery: "accepted" } });
					const answerRetry = await reconnected.request("answer_question", {
						questionId: directQuestion?.questionId,
						answers: { "Which value should I use?": "42" },
					});
					expect(answerRetry).toMatchObject({ success: true, data: { delivery: "accepted" } });
					const conflictingAnswer = await reconnected.request("answer_question", {
						questionId: directQuestion?.questionId,
						answers: { "Which value should I use?": "43" },
					});
					expect(conflictingAnswer).toMatchObject({ success: false, error: { code: "already_resolved" } });
					await reconnected.waitForEvent(
						(event) =>
							event.type === "question_updated" &&
							(event.question as Frame | undefined)?.questionId === directQuestion?.questionId &&
							(event.question as Frame | undefined)?.state === "answered",
					);
					const followUp = await agent.waitForLlmRequest((item) => JSON.stringify(item.messages).includes("42"));
					agent.respondToLlmRequest(
						followUp.id,
						fauxAssistantMessage(
							[{ type: "text", text: "I used 42." }, fauxToolCall("end_turn", { reason: "Answered with 42" })],
							{ stopReason: "toolUse" },
						),
					);
					await reconnected.waitForEvent(
						(event) => event.type === "session_event" && (event.event as Frame | undefined)?.type === "agent_end",
					);
					await reconnected.request("detach_session", { sessionId, runtimeInstanceId });
					const stopped = await reconnected.request("stop_session", { sessionId, runtimeInstanceId });
					expect(stopped).toMatchObject({
						success: true,
						data: { session: { sessionId, status: "ended", owner: "external" } },
					});
					const visibleSessions = await list(reconnected);
					expect(visibleSessions).toContainEqual(
						expect.objectContaining({ sessionId, status: "ended", owner: "external" }),
					);
					const currentSessions = await reconnected.request("list_sessions", { includeEnded: false });
					expect(
						(currentSessions.data as { sessions: Frame[] }).sessions.some(
							(entry) => entry.sessionId === sessionId,
						),
					).toBe(false);
					const reattachEnded = await reconnected.request("attach_session", { sessionId, mode: "observe" });
					expect(reattachEnded).toMatchObject({ success: false, error: { code: "not_running" } });
				} finally {
					reconnected.close();
				}
			} finally {
				client.close();
				await stopDaemon(daemon, runtimeDir);
			}
		});
	}, 120_000);
});
