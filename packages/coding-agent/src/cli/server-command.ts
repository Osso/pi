import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "../config.ts";
import type { ExtensionUIQuestion } from "../core/extensions/types.ts";
import { getControlDbPath } from "../core/session-control-db.ts";
import { listSessions } from "../core/session-directory.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import type { RpcEvent, RpcResponse } from "../modes/rpc/rpc-types.ts";

type RpcCommandResponse = Extract<RpcResponse, { command: "get_state" }>;

import {
	type AgentQuestionEntry,
	answerAgentQuestion,
	listQuestionEntries,
	openQuestionCenter,
} from "../questions/question-center.ts";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1_048_576;
const SERVER_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

type ServerSessionSummary = {
	sessionId: string;
	name: string | null;
	cwd: string | null;
	status: "running" | "idle" | "ended";
	checkStatus: string;
	eligibleToReceive: boolean;
	agentGeneration: number;
	lastActiveAt: string | null;
	owner: "server" | "external";
	attachment: "rpc" | "terminal" | "none";
	runtimeInstanceId?: string;
	sessionPath?: string;
};

type Worker = {
	child: ChildProcess;
	sessionId: string;
	sessionPath?: string;
	cwd: string;
	name: string | null;
	runtimeInstanceId: string;
	sequence: number;
	requestNumber: number;
	pending: Map<string, (response: RpcResponse) => void>;
	clients: Set<Client>;
	directQuestions: Map<
		string,
		{ dialogId: string; toolCallId: string; blocking: boolean; createdAt: string; questions: ExtensionUIQuestion[] }
	>;
	answeredDirectQuestions: Map<string, { answers: Record<string, string>; question: Record<string, unknown> }>;
	stderr: string;
};

type Attachment = {
	mode: "observe" | "control";
	buffering: boolean;
	events: Array<{ sequence: number; event: RpcEvent }>;
};
type Client = { socket: Socket; attachments: Map<string, Attachment>; subscriptions: Set<"sessions" | "questions"> };
type RevisionCounters = { sessions: number; questions: number };

function socketPath(): string {
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (!runtimeDir) throw new Error("XDG_RUNTIME_DIR is required for pi server");
	return join(runtimeDir, "pi", "server.sock");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function writeFrame(socket: Socket, frame: unknown): void {
	if (socket.destroyed) return;
	const line = `${JSON.stringify(frame)}\n`;
	if (socket.writableLength + Buffer.byteLength(line) > MAX_FRAME_BYTES) {
		socket.destroy(new Error("Client output buffer exceeds 1 MiB"));
		return;
	}
	socket.write(line);
}

function sessionSummaries(workers: Map<string, Worker>): ServerSessionSummary[] {
	const owned = new Map([...workers.values()].map((worker) => [worker.sessionId, worker] as const));
	return listSessions(getControlDbPath(), { includeEnded: true }).map((entry) => {
		const worker = owned.get(entry.sessionId);
		return {
			sessionId: entry.sessionId,
			name: entry.name,
			cwd: entry.cwd,
			status: entry.status,
			checkStatus: entry.checkStatus,
			eligibleToReceive: entry.eligibleToReceive,
			agentGeneration: entry.agentGeneration,
			lastActiveAt: entry.lastActiveAt,
			owner: worker ? "server" : "external",
			attachment: worker ? "rpc" : entry.status === "running" || entry.status === "idle" ? "terminal" : "none",
			...(worker ? { runtimeInstanceId: worker.runtimeInstanceId } : {}),
			sessionPath: entry.sessionPath,
		};
	});
}

function questionUpdates(workers: Map<string, Worker>): Array<Record<string, unknown>> {
	const stored = listQuestionEntries(controlCenter())
		.filter((entry): entry is AgentQuestionEntry => entry.direction === "agent" && entry.state !== "supervisor")
		.map(makeQuestionSummary);
	const pending = [...workers.values()].flatMap((worker) =>
		[...worker.directQuestions].map(([questionId, question]) => ({
			questionId,
			sessionId: worker.sessionId,
			originSessionId: worker.sessionId,
			agentId: null,
			toolCallId: question.toolCallId,
			blocking: question.blocking,
			questions: question.questions,
			createdAt: question.createdAt,
			state: "pending",
			review: "none",
			answerable: true,
		})),
	);
	const answered = [...workers.values()].flatMap((worker) =>
		[...worker.answeredDirectQuestions.values()].map((answer) => answer.question),
	);
	return [...stored, ...pending, ...answered];
}

function questionSummaries(workers: Map<string, Worker>): Array<Record<string, unknown>> {
	return questionUpdates(workers).filter((question) => question.state === "pending");
}

function rpcCommand(worker: Worker, command: Record<string, unknown>): Promise<RpcResponse> {
	const id = `server-${++worker.requestNumber}`;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			worker.pending.delete(id);
			reject(new Error("RPC worker did not answer within 30 seconds"));
		}, 30_000);
		worker.pending.set(id, (response) => {
			clearTimeout(timeout);
			resolve(response);
		});
		if (!worker.child.stdin?.writable) {
			clearTimeout(timeout);
			worker.pending.delete(id);
			reject(new Error("RPC worker stdin is closed"));
			return;
		}
		worker.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
			if (error) {
				clearTimeout(timeout);
				worker.pending.delete(id);
				reject(error);
			}
		});
	});
}

function parseWorkerLine(worker: Worker, line: string): void {
	let frame: Record<string, unknown>;
	try {
		frame = JSON.parse(line) as Record<string, unknown>;
	} catch {
		worker.stderr += `\nInvalid RPC worker frame: ${line}`;
		return;
	}
	if (frame.type === "response" && typeof frame.id === "string") {
		worker.pending.get(frame.id)?.(frame as unknown as RpcResponse);
		worker.pending.delete(frame.id);
		return;
	}
	if (frame.type === "response") return;
	const event = frame as unknown as RpcEvent;
	if (
		frame.type === "extension_ui_request" &&
		frame.method === "questions" &&
		typeof frame.id === "string" &&
		Array.isArray(frame.questions)
	) {
		const questionId = `${worker.sessionId}:${frame.id}`;
		const questions = frame.questions as ExtensionUIQuestion[];
		worker.directQuestions.set(questionId, {
			dialogId: frame.id,
			toolCallId: typeof frame.toolCallId === "string" ? frame.toolCallId : frame.id,
			blocking: frame.blocking === true,
			createdAt: new Date().toISOString(),
			questions,
		});
	}
	if (frame.type === "extension_ui_dismiss" && typeof frame.id === "string")
		worker.directQuestions.delete(`${worker.sessionId}:${frame.id}`);
	const sequence = ++worker.sequence;
	for (const client of worker.clients) {
		const attachment = client.attachments.get(worker.sessionId);
		if (!attachment) continue;
		const packet = { sequence, event };
		if (attachment.buffering) attachment.events.push(packet);
		else
			writeFrame(client.socket, {
				type: "session_event",
				sessionId: worker.sessionId,
				runtimeInstanceId: worker.runtimeInstanceId,
				...packet,
			});
	}
}

function startWorker(cwd: string, resumePath?: string, name?: string): Worker {
	const cliEntry = process.argv[1];
	if (!cliEntry) throw new Error("Cannot locate Pi CLI entry point");
	const args = [...process.execArgv, cliEntry, "--mode", "rpc"];
	if (resumePath) args.push("--session", resumePath);
	if (name) args.push("--name", name);
	const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
	const worker: Worker = {
		child,
		sessionId: "",
		cwd,
		name: name ?? null,
		runtimeInstanceId: crypto.randomUUID(),
		sequence: 0,
		requestNumber: 0,
		pending: new Map(),
		clients: new Set(),
		directQuestions: new Map(),
		answeredDirectQuestions: new Map(),
		stderr: "",
	};
	const childStdout = child.stdout;
	if (!childStdout) {
		child.kill();
		throw new Error("RPC worker stdout is not piped");
	}
	const stdout = createInterface({ input: childStdout, crlfDelay: Infinity });
	stdout.on("line", (line) => parseWorkerLine(worker, line));
	child.stderr?.on("data", (chunk: Buffer) => {
		worker.stderr = `${worker.stderr}${chunk.toString()}`.slice(-16_384);
	});
	child.on("exit", () => {
		for (const resolve of worker.pending.values())
			resolve({
				type: "response",
				command: "get_state",
				success: false,
				error: worker.stderr,
			} as unknown as RpcResponse);
		worker.pending.clear();
	});
	return worker;
}

function sessionPathForId(sessionId: string): string | undefined {
	return listSessions(getControlDbPath(), { includeEnded: true }).find((session) => session.sessionId === sessionId)
		?.sessionPath;
}

function sameAnswers(left: Record<string, string> | undefined, right: Record<string, string>): boolean {
	if (!left) return false;
	const entries = Object.entries(right);
	return (
		entries.length === Object.keys(left).length && entries.every(([question, answer]) => left[question] === answer)
	);
}

function controlCenter() {
	const settings = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	return openQuestionCenter(settings, getControlDbPath());
}

function makeQuestionSummary(entry: AgentQuestionEntry) {
	return {
		questionId: entry.ref,
		sessionId: entry.session.sessionId,
		originSessionId: entry.session.sessionId,
		agentId: null,
		toolCallId: entry.toolCallId,
		blocking: entry.blocking,
		questions: entry.questions,
		createdAt: entry.createdAt,
		state: entry.state === "open" ? "pending" : entry.state,
		review: "escalated",
		answerable: entry.state === "open",
		...(entry.answers ? { answers: entry.answers } : {}),
		...(entry.answeredBy ? { answeredBy: entry.answeredBy } : {}),
	};
}

async function handleCommand(
	frame: Record<string, unknown>,
	client: Client,
	workers: Map<string, Worker>,
	serverInstanceId: string,
	revisions: RevisionCounters,
	publishUpdates: () => void,
): Promise<void> {
	const id = frame.id;
	const type = frame.type;
	const respond = (data: unknown) =>
		writeFrame(client.socket, { type: "response", id, command: type, success: true, data });
	const fail = (code: string, message: string) =>
		writeFrame(client.socket, { type: "response", id, command: type, success: false, error: { code, message } });
	try {
		switch (type) {
			case "hello":
				if (frame.version !== PROTOCOL_VERSION)
					return fail("unsupported_version", `Supported protocol version is ${PROTOCOL_VERSION}`);
				return respond({
					version: PROTOCOL_VERSION,
					hostId: hostname(),
					serverInstanceId,
					features: ["sessions", "rpc", "questions"],
				});
			case "list_sessions": {
				publishUpdates();
				client.subscriptions.add("sessions");
				const sessions = sessionSummaries(workers);
				const visibleSessions =
					frame.includeEnded === false ? sessions.filter((session) => session.status !== "ended") : sessions;
				return respond({ sessions: visibleSessions, revision: revisions.sessions });
			}
			case "start_session": {
				if (typeof frame.cwd !== "string" || !frame.cwd)
					return fail("invalid_request", "cwd must be a non-empty path");
				if (frame.resumeSessionId !== undefined && typeof frame.resumeSessionId !== "string")
					return fail("invalid_request", "resumeSessionId must be a string");
				if (typeof frame.resumeSessionId === "string" && workers.has(frame.resumeSessionId))
					return fail("already_running", "Session is already managed by this server");
				const resumePath =
					typeof frame.resumeSessionId === "string" ? sessionPathForId(frame.resumeSessionId) : undefined;
				if (typeof frame.resumeSessionId === "string" && !resumePath)
					return fail("not_found", "Saved session was not found");
				if (typeof frame.resumeSessionId === "string") {
					const existing = sessionSummaries(workers).find((s) => s.sessionId === frame.resumeSessionId);
					if (existing?.status !== "ended") return fail("already_running", "Session has a live writer");
				}
				const worker = startWorker(frame.cwd, resumePath, typeof frame.name === "string" ? frame.name : undefined);
				let sessionId: string | undefined;
				const reservation =
					typeof frame.resumeSessionId === "string"
						? frame.resumeSessionId
						: `starting:${worker.runtimeInstanceId}`;
				workers.set(reservation, worker);
				try {
					const state = await rpcCommand(worker, { type: "get_state" });
					const stateData = (state as RpcCommandResponse).data;
					if (!state.success || !stateData || typeof stateData !== "object")
						throw new Error(`RPC worker startup failed: ${JSON.stringify(state)}`);
					const reportedSessionId = (stateData as { sessionId?: unknown }).sessionId;
					if (typeof reportedSessionId !== "string" || !reportedSessionId)
						throw new Error("RPC worker did not report a session ID");
					sessionId = reportedSessionId;
					if (typeof frame.resumeSessionId === "string" && sessionId !== frame.resumeSessionId)
						throw new Error(`Resumed worker opened ${sessionId}, expected ${frame.resumeSessionId}`);
					worker.sessionId = sessionId;
					worker.sessionPath = (stateData as { sessionFile?: string }).sessionFile;
					if (workers.get(sessionId) && workers.get(sessionId) !== worker)
						throw new Error("Session is already managed by this server");
					workers.delete(reservation);
					workers.set(sessionId, worker);
				} catch (error) {
					workers.delete(reservation);
					worker.child.kill("SIGTERM");
					throw error;
				}
				return respond({
					session: sessionId ? sessionSummaries(workers).find((s) => s.sessionId === sessionId) : undefined,
				});
			}
			case "stop_session": {
				const worker = workers.get(String(frame.sessionId));
				if (!worker) return fail("not_managed", "Session is not owned by this server");
				if (frame.runtimeInstanceId !== worker.runtimeInstanceId)
					return fail("stale_runtime", "Runtime instance ID does not match");
				workers.delete(worker.sessionId);
				worker.child.stdin?.end();
				await new Promise<void>((resolve) => worker.child.once("exit", () => resolve()));
				return respond({ session: sessionSummaries(workers).find((s) => s.sessionId === worker.sessionId) });
			}
			case "attach_session": {
				const worker = workers.get(String(frame.sessionId));
				if (!worker) {
					const session = sessionSummaries(workers).find((entry) => entry.sessionId === frame.sessionId);
					if (session?.status === "ended") return fail("not_running", "Session is not running");
					return fail("not_attachable", "Session is not an RPC worker owned by this server");
				}
				if (frame.mode !== "observe" && frame.mode !== "control")
					return fail("invalid_request", "mode must be observe or control");
				if (
					frame.mode === "control" &&
					[...worker.clients].some(
						(other) => other !== client && other.attachments.get(worker.sessionId)?.mode === "control",
					)
				)
					return fail("controller_busy", "Another client controls this session");
				const attachment: Attachment = { mode: frame.mode, buffering: true, events: [] };
				client.attachments.set(worker.sessionId, attachment);
				worker.clients.add(client);
				const snapshot: Record<string, unknown> = {};
				let snapshotWatermark = worker.sequence;
				for (const command of ["get_state", "get_messages", "get_agents"]) {
					const response = await rpcCommand(worker, { type: command });
					if (response.success) snapshot[command] = (response as RpcCommandResponse).data;
					if (command === "get_messages") snapshotWatermark = worker.sequence;
				}
				const firstSequence = snapshotWatermark + 1;
				attachment.buffering = false;
				for (const event of attachment.events) {
					if (event.sequence >= firstSequence)
						writeFrame(client.socket, {
							type: "session_event",
							sessionId: worker.sessionId,
							runtimeInstanceId: worker.runtimeInstanceId,
							...event,
						});
				}
				attachment.events = [];
				return respond({
					session: sessionSummaries(workers).find((s) => s.sessionId === worker.sessionId),
					runtimeInstanceId: worker.runtimeInstanceId,
					firstSequence,
					mode: frame.mode,
					snapshot,
				});
			}
			case "detach_session": {
				const worker = workers.get(String(frame.sessionId));
				const attachment = client.attachments.get(String(frame.sessionId));
				if (!worker || !attachment) return fail("not_attached", "Client is not attached to this session");
				if (frame.runtimeInstanceId !== worker.runtimeInstanceId)
					return fail("stale_runtime", "Runtime instance ID does not match");
				client.attachments.delete(worker.sessionId);
				worker.clients.delete(client);
				return respond({ detached: true });
			}
			case "session_rpc": {
				if (
					typeof frame.sessionId !== "string" ||
					typeof frame.runtimeInstanceId !== "string" ||
					!frame.command ||
					typeof frame.command !== "object"
				)
					return fail("invalid_request", "sessionId, runtimeInstanceId, and command are required");
				const worker = workers.get(frame.sessionId);
				const attachment = client.attachments.get(frame.sessionId);
				if (!worker || !attachment) return fail("not_attached", "Attach to the session first");
				if (frame.runtimeInstanceId !== worker.runtimeInstanceId)
					return fail("stale_runtime", "Runtime instance ID does not match");
				const command = frame.command as Record<string, unknown>;
				if (["new_session", "switch_session", "fork", "clone"].includes(String(command.type)))
					return fail("identity_change_rejected", "Identity-changing RPC commands are disabled in v1");
				if (
					attachment.mode !== "control" &&
					![
						"get_state",
						"get_messages",
						"get_agents",
						"get_commands",
						"get_tree",
						"get_entries",
						"get_last_assistant_text",
						"get_session_stats",
					].includes(String(command.type))
				)
					return fail("read_only", "Observer attachment cannot send this RPC command");
				const response = await rpcCommand(worker, command);
				return respond({ response: { ...response, id: command.id } });
			}
			case "list_questions": {
				publishUpdates();
				client.subscriptions.add("questions");
				return respond({ questions: questionSummaries(workers), revision: revisions.questions });
			}
			case "answer_question": {
				if (
					typeof frame.questionId !== "string" ||
					!frame.answers ||
					typeof frame.answers !== "object" ||
					Array.isArray(frame.answers)
				)
					return fail("invalid_request", "questionId and answers are required");
				const answerValues = Object.values(frame.answers);
				if (answerValues.some((answer) => typeof answer !== "string"))
					return fail("invalid_answer", "Every answer must be text");
				const answers = frame.answers as Record<string, string>;
				for (const worker of workers.values()) {
					const previousAnswer = worker.answeredDirectQuestions.get(frame.questionId);
					if (previousAnswer) {
						if (!sameAnswers(previousAnswer.answers, answers))
							return fail("already_resolved", "Question was answered with different values");
						return respond({ question: previousAnswer.question, delivery: "accepted" });
					}
					const direct = worker.directQuestions.get(frame.questionId);
					if (!direct) continue;
					if (
						direct.questions.some((question) => {
							const answer = answers[question.question];
							return typeof answer !== "string" || !answer.trim();
						})
					)
						return fail("invalid_answer", "An answer is required for every question");
					if (!worker.child.stdin?.writable) return fail("stale_runtime", "Question runtime is not available");
					worker.child.stdin.write(
						`${JSON.stringify({ type: "extension_ui_response", id: direct.dialogId, answers })}\n`,
					);
					worker.directQuestions.delete(frame.questionId);
					const question = {
						questionId: frame.questionId,
						sessionId: worker.sessionId,
						originSessionId: worker.sessionId,
						agentId: null,
						toolCallId: direct.toolCallId,
						blocking: direct.blocking,
						questions: direct.questions,
						createdAt: direct.createdAt,
						state: "answered",
						review: "none",
						answerable: false,
						answers,
						answeredBy: "user",
						delivery: "accepted",
					};
					worker.answeredDirectQuestions.set(frame.questionId, { answers, question });
					return respond({ question, delivery: "accepted" });
				}
				const center = controlCenter();
				const entry = listQuestionEntries(center).find(
					(item): item is AgentQuestionEntry => item.direction === "agent" && item.ref === frame.questionId,
				);
				if (!entry) return fail("not_found", "Question not found");
				if (entry.state === "answered" && sameAnswers(entry.answers, answers))
					return respond({ question: makeQuestionSummary(entry), delivery: "delivered" });
				if (entry.state !== "open") return fail("already_resolved", "Question is no longer pending");
				answerAgentQuestion(center, entry, answers);
				const updated = listQuestionEntries(center).find(
					(item): item is AgentQuestionEntry => item.direction === "agent" && item.ref === frame.questionId,
				);
				const question = updated
					? makeQuestionSummary(updated)
					: makeQuestionSummary({ ...entry, state: "answered", answers, answeredBy: "user" });
				return respond({ question, delivery: "delivered" });
			}
			default:
				return fail("unknown_command", `Unknown server command: ${String(type)}`);
		}
	} catch (error) {
		return fail("server_error", errorMessage(error));
	}
}

async function runStdioConnector(path: string): Promise<void> {
	const socket = createConnection(path);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
	await new Promise<void>((resolve) => socket.once("close", resolve));
}

async function runServer(): Promise<void> {
	const path = socketPath();
	mkdirSync(dirname(path), { recursive: true, mode: SERVER_DIR_MODE });
	chmodSync(dirname(path), SERVER_DIR_MODE);
	try {
		const stat = statSync(path);
		if (stat.isSocket()) throw new Error(`Server socket already exists at ${path}`);
		throw new Error(`Refusing to replace non-socket at ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const workers = new Map<string, Worker>();
	const clients = new Set<Client>();
	const serverInstanceId = crypto.randomUUID();
	const revisions: RevisionCounters = { sessions: 0, questions: 0 };
	let previousSessions = new Map<string, string>();
	let previousQuestions = new Map<string, string>();
	const publishUpdates = () => {
		try {
			const currentSessions = new Map(
				sessionSummaries(workers).map((session) => [session.sessionId, JSON.stringify(session)]),
			);
			const currentQuestions = new Map(
				questionUpdates(workers).map((question) => [String(question.questionId), JSON.stringify(question)]),
			);
			const sessionEvents: unknown[] = [];
			for (const [sessionId, value] of currentSessions) {
				if (previousSessions.get(sessionId) !== value)
					sessionEvents.push({
						type: "session_updated",
						revision: ++revisions.sessions,
						session: JSON.parse(value),
					});
			}
			for (const sessionId of previousSessions.keys()) {
				if (!currentSessions.has(sessionId))
					sessionEvents.push({ type: "session_removed", revision: ++revisions.sessions, sessionId });
			}
			const questionEvents: unknown[] = [];
			for (const [questionId, value] of currentQuestions) {
				if (previousQuestions.get(questionId) !== value)
					questionEvents.push({
						type: "question_updated",
						revision: ++revisions.questions,
						question: JSON.parse(value),
					});
			}
			for (const client of clients) {
				if (client.subscriptions.has("sessions"))
					for (const event of sessionEvents) writeFrame(client.socket, event);
				if (client.subscriptions.has("questions"))
					for (const event of questionEvents) writeFrame(client.socket, event);
			}
			previousSessions = currentSessions;
			previousQuestions = currentQuestions;
		} catch (error) {
			console.error(`pi server update: ${errorMessage(error)}`);
		}
	};
	const updateTimer = setInterval(publishUpdates, 500);
	const server = createServer((socket) => {
		const client: Client = { socket, attachments: new Map(), subscriptions: new Set() };
		clients.add(client);
		socket.setEncoding("utf8");
		let buffered = "";
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) {
					if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) socket.destroy(new Error("Frame exceeds 1 MiB"));
					break;
				}
				const line = buffered.slice(0, newline).replace(/\r$/, "");
				buffered = buffered.slice(newline + 1);
				if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
					socket.destroy(new Error("Frame exceeds 1 MiB"));
					return;
				}
				try {
					void handleCommand(
						JSON.parse(line) as Record<string, unknown>,
						client,
						workers,
						serverInstanceId,
						revisions,
						publishUpdates,
					);
				} catch {
					writeFrame(socket, {
						type: "response",
						success: false,
						error: { code: "invalid_json", message: "Invalid JSON frame" },
					});
				}
			}
		});
		socket.on("close", () => {
			clients.delete(client);
			for (const sessionId of client.attachments.keys()) workers.get(sessionId)?.clients.delete(client);
			client.attachments.clear();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});
	chmodSync(path, SOCKET_MODE);
	const close = () => {
		clearInterval(updateTimer);
		for (const worker of workers.values()) worker.child.kill("SIGTERM");
		server.close();
		rmSync(path, { force: true });
	};
	process.once("SIGTERM", close);
	process.once("SIGINT", close);
	await new Promise<void>((resolve) => server.once("close", resolve));
}

/** Runs `pi server` or the SSH stdio connector. */
export async function handleServerCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "server") return false;
	try {
		if (args.length === 2 && args[1] === "--stdio") await runStdioConnector(socketPath());
		else if (args.length === 1) await runServer();
		else throw new Error("Usage: pi server [--stdio]");
	} catch (error) {
		console.error(`pi server: ${errorMessage(error)}`);
		process.exitCode = 1;
	}
	return true;
}
