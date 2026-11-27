import { spawn } from "node:child_process";
import { getAgentDir } from "../config.ts";
import type { ExtensionUIQuestion } from "../core/extensions/types.ts";
import { isResidentSession } from "../core/resident-session.ts";
import type { SessionMetadata } from "../core/session-control-db/types.ts";
import { getControlDbPath, listResumeSessionMetadata } from "../core/session-control-db.ts";
import { listSessions } from "../core/session-directory.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { attachJsonlLineReader } from "../modes/rpc/jsonl.ts";
import type { RpcEvent, RpcResponse } from "../modes/rpc/rpc-types.ts";
import type { ServerSessionSummary, Worker } from "./server-command.ts";
import { workerLaunchPrefix } from "./server-launch.ts";
import { readActiveSessionAgents } from "./server-session-agents.ts";

/** The sessions `pi -r` offers (indexed, not archived, not a sub-agent or resident, with messages), by id. */
function resumableSessions(controlDbPath: string): Map<string, SessionMetadata> {
	const sessions = listResumeSessionMetadata(controlDbPath, { archived: false }).filter(
		(session) => session.messageCount > 0 && !isResidentSession({ id: session.id, path: session.sessionPath }),
	);
	return new Map(sessions.map((session) => [session.id, session] as const));
}

/** The configured Supervisor session, named `Supervisor` when it has no name of its own. */
function supervisorSessionId(): string | undefined {
	const settings = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	return settings.getMergedSettings().supervisor?.sessionId;
}

/**
 * The sessions `pi -r` offers, plus every session that runs now; unnamed ones carry their first message.
 * A session that is not ended carries its non-terminal sub-agents, when it has any.
 */
export function sessionSummaries(workers: Map<string, Worker>): ServerSessionSummary[] {
	const owned = new Map([...workers.values()].map((worker) => [worker.sessionId, worker] as const));
	const controlDbPath = getControlDbPath();
	const resumable = resumableSessions(controlDbPath);
	const supervisorId = supervisorSessionId();
	const listed = listSessions(controlDbPath, { includeEnded: true }).filter(
		(entry) => owned.has(entry.sessionId) || entry.status !== "ended" || resumable.has(entry.sessionId),
	);
	const agents = readActiveSessionAgents(
		controlDbPath,
		listed.filter((entry) => entry.status !== "ended").map((entry) => entry.sessionPath),
	);
	return listed.map((entry) => {
		const worker = owned.get(entry.sessionId);
		const firstMessage = resumable.get(entry.sessionId)?.firstMessage;
		const sessionAgents = entry.status === "ended" ? undefined : agents.get(entry.sessionPath);
		return {
			...(firstMessage ? { firstMessage } : {}),
			sessionId: entry.sessionId,
			name: entry.name ?? (entry.sessionId === supervisorId ? "Supervisor" : null),
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
			...(sessionAgents ? { agents: sessionAgents } : {}),
			...(entry.sessionId === supervisorId ? { supervisor: true as const } : {}),
		};
	});
}

/** Commands answered only when an extension command they run finishes, which can wait on a person in a dialog. */
const UNBOUNDED_COMMANDS = new Set(["prompt", "steer", "follow_up"]);

/**
 * Send one RPC command and await its response. Commands time out after 30 seconds, except the unbounded ones
 * and `options.untilExit`: the startup `get_state` of a worker that loads a large session waits as long as
 * the worker lives.
 */
export function rpcCommand(
	worker: Worker,
	command: Record<string, unknown>,
	options: { untilExit?: boolean } = {},
): Promise<RpcResponse> {
	const id = `server-${++worker.requestNumber}`;
	return new Promise((resolve, reject) => {
		// A worker that exits answers every pending command (see startWorker), so an unbounded command cannot hang.
		const timeout =
			options.untilExit || UNBOUNDED_COMMANDS.has(String(command.type))
				? undefined
				: setTimeout(() => {
						worker.pending.delete(id);
						reject(new Error("RPC worker did not answer within 30 seconds"));
					}, 30_000);
		worker.pending.set(id, (response) => {
			clearTimeout(timeout);
			resolve(response);
		});
		writeWorkerLine(worker, { ...command, id }).catch((error: unknown) => {
			clearTimeout(timeout);
			worker.pending.delete(id);
			reject(error);
		});
	});
}

/** Write one frame to the worker. A dialog answer (`extension_ui_response`) gets no RPC response and keeps its id. */
export function writeWorkerLine(worker: Worker, frame: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!worker.child.stdin?.writable) {
			reject(new Error("RPC worker stdin is closed"));
			return;
		}
		worker.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => (error ? reject(error) : resolve()));
	});
}

export function parseWorkerLine(worker: Worker, line: string): void {
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
			client.send({
				type: "session_event",
				sessionId: worker.sessionId,
				runtimeInstanceId: worker.runtimeInstanceId,
				...packet,
			});
	}
}

export function startWorker(cwd: string, resumePath?: string, name?: string): Worker {
	const args = [...workerLaunchPrefix(), "--mode", "rpc"];
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
	// Strict LF framing: readline also splits at U+2028/U+2029, which JSON leaves unescaped inside strings.
	attachJsonlLineReader(childStdout, (line) => parseWorkerLine(worker, line));
	child.stderr?.on("data", (chunk: Buffer) => {
		worker.stderr = `${worker.stderr}${chunk.toString()}`.slice(-16_384);
	});
	// A spawn failure (e.g. a cwd removed after validation) ends this worker only, never the daemon.
	child.once("error", (error) => {
		worker.stderr = `${worker.stderr}${error.message}`.slice(-16_384);
		child.emit("exit", null, null);
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

export function sessionPathForId(sessionId: string): string | undefined {
	return listSessions(getControlDbPath(), { includeEnded: true }).find((session) => session.sessionId === sessionId)
		?.sessionPath;
}
