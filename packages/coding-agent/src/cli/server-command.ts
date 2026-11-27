import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import type { ExtensionUIQuestion } from "../core/extensions/types.ts";
import { getControlDbPath } from "../core/session-control-db.ts";
import { deleteSessionTree } from "../core/session-delete.ts";
import type { RpcEvent, RpcResponse } from "../modes/rpc/rpc-types.ts";
import type { HubClient, ServerHub } from "./server-hub.ts";
import { handleAnswerQuestion } from "./server-question-handlers.ts";
import { questionStoreHost, questionSummaries } from "./server-question-utils.ts";
import { forgetOwnedSession, readOwnedSessions, rememberOwnedSession } from "./server-restore.ts";
import { handleArchiveSession, handleRenameSession } from "./server-session-admin.ts";
import type { ServerSessionAgent } from "./server-session-agents.ts";
import { errorMessage, serverHostId } from "./server-wire.ts";
import { rpcCommand, sessionPathForId, sessionSummaries, startWorker, writeWorkerLine } from "./server-worker.ts";

type RpcCommandResponse = Extract<RpcResponse, { command: "get_state" }>;

export const PROTOCOL_VERSION = 1;

export type ServerSessionSummary = {
	sessionId: string;
	name: string | null;
	/** The first user message, as `pi -r` shows it; absent when the session is not in the resume index. */
	firstMessage?: string;
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
	/** Non-terminal sub-agents of a session that is not ended; absent when there are none. */
	agents?: ServerSessionAgent[];
	/** The configured Supervisor session (`supervisor.sessionId`); absent on other sessions. */
	supervisor?: true;
};

export type Worker = {
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
export type Subscription = "sessions" | "questions" | "machines";
/** One protocol connection: a socket client, or on a spoke, one hub connection carried over the link. */
export type Client = {
	send: (frame: unknown) => void;
	attachments: Map<string, Attachment>;
	subscriptions: Set<Subscription>;
	/** Set on the hub: the handle used to forward this client's frames to spokes. */
	hubClient?: HubClient;
};
export type RevisionCounters = { sessions: number; questions: number };

export type ServerState = {
	workers: Map<string, Worker>;
	serverInstanceId: string;
	revisions: RevisionCounters;
	publishUpdates: () => void;
	hub?: ServerHub;
};

export type CommandContext = ServerState & {
	frame: Record<string, unknown>;
	client: Client;
	respond: (data: unknown) => void;
	fail: (code: string, message: string) => void;
};

type CommandHandler = (context: CommandContext) => Promise<void>;

async function handleHello({ frame, serverInstanceId, hub, respond, fail }: CommandContext): Promise<void> {
	if (frame.version !== PROTOCOL_VERSION)
		return fail("unsupported_version", `Supported protocol version is ${PROTOCOL_VERSION}`);
	return respond({
		version: PROTOCOL_VERSION,
		hostId: serverHostId(),
		serverInstanceId,
		features: hub ? ["sessions", "rpc", "questions", "machines"] : ["sessions", "rpc", "questions"],
		questionStoreHost: questionStoreHost(),
	});
}

/** On the hub, entries carry hostId; with no hostId in the request, every machine's last known entries are included. */
function withMachines(
	local: Record<string, unknown>[],
	frame: Record<string, unknown>,
	hub: ServerHub | undefined,
	cached: (hub: ServerHub) => Record<string, unknown>[],
): Record<string, unknown>[] {
	if (!hub) return local;
	const tagged = local.map((entry) => ({ ...entry, hostId: hub.hostId }));
	return frame.hostId === undefined ? [...tagged, ...cached(hub)] : tagged;
}

async function handleListSessions({ frame, client, workers, revisions, publishUpdates, hub, respond }: CommandContext) {
	publishUpdates();
	client.subscriptions.add("sessions");
	const sessions = withMachines(sessionSummaries(workers), frame, hub, (machines) => machines.cachedSessions());
	const visibleSessions =
		frame.includeEnded === false ? sessions.filter((session) => session.status !== "ended") : sessions;
	return respond({ sessions: visibleSessions, revision: revisions.sessions });
}

type SessionStartRequest = { cwd: string; resumeSessionId?: string; resumePath?: string };

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function validateSessionStart(
	frame: Record<string, unknown>,
	workers: Map<string, Worker>,
	fail: CommandContext["fail"],
): SessionStartRequest | undefined {
	if (typeof frame.cwd !== "string" || !frame.cwd) {
		fail("invalid_request", "cwd must be a non-empty path");
		return undefined;
	}
	if (!isDirectory(frame.cwd)) {
		fail("invalid_cwd", `cwd is not a directory on this machine: ${frame.cwd}`);
		return undefined;
	}
	if (frame.resumeSessionId !== undefined && typeof frame.resumeSessionId !== "string") {
		fail("invalid_request", "resumeSessionId must be a string");
		return undefined;
	}
	const resumeSessionId = typeof frame.resumeSessionId === "string" ? frame.resumeSessionId : undefined;
	if (resumeSessionId === undefined) return { cwd: frame.cwd };
	if (workers.has(resumeSessionId)) {
		fail("already_running", "Session is already managed by this server");
		return undefined;
	}
	const resumePath = sessionPathForId(resumeSessionId);
	if (!resumePath) {
		fail("not_found", "Saved session was not found");
		return undefined;
	}
	const existing = sessionSummaries(workers).find((session) => session.sessionId === resumeSessionId);
	if (existing?.status !== "ended") {
		fail("already_running", "Session has a live writer");
		return undefined;
	}
	return { cwd: frame.cwd, resumeSessionId, resumePath };
}

async function registerStartedWorker(
	worker: Worker,
	workers: Map<string, Worker>,
	resumeSessionId?: string,
): Promise<string> {
	const reservation = resumeSessionId ?? `starting:${worker.runtimeInstanceId}`;
	workers.set(reservation, worker);
	try {
		const state = await rpcCommand(worker, { type: "get_state" });
		const stateData = (state as RpcCommandResponse).data;
		if (!state.success || !stateData || typeof stateData !== "object")
			throw new Error(`RPC worker startup failed: ${JSON.stringify(state)}`);
		const sessionId = (stateData as { sessionId?: unknown }).sessionId;
		if (typeof sessionId !== "string" || !sessionId) throw new Error("RPC worker did not report a session ID");
		if (resumeSessionId && sessionId !== resumeSessionId)
			throw new Error(`Resumed worker opened ${sessionId}, expected ${resumeSessionId}`);
		worker.sessionId = sessionId;
		worker.sessionPath = (stateData as { sessionFile?: string }).sessionFile;
		if (workers.get(sessionId) && workers.get(sessionId) !== worker)
			throw new Error("Session is already managed by this server");
		workers.delete(reservation);
		workers.set(sessionId, worker);
		rememberOwnedSession({ sessionId, cwd: worker.cwd });
		// A worker that exits on its own is no longer owned; the directory then lists the session as ended.
		// One that quit (exit 0) stays ended; one killed with the server (signal, crash) reopens with it.
		worker.child.once("exit", (code) => {
			if (workers.get(sessionId) === worker) workers.delete(sessionId);
			if (code === 0) forgetOwnedSession(sessionId);
		});
		return sessionId;
	} catch (error) {
		workers.delete(reservation);
		worker.child.kill("SIGTERM");
		throw error;
	}
}

async function handleStartSession({ frame, workers, respond, fail }: CommandContext): Promise<void> {
	const request = validateSessionStart(frame, workers, fail);
	if (!request) return;
	const name = typeof frame.name === "string" ? frame.name : undefined;
	const worker = startWorker(request.cwd, request.resumePath, name);
	const sessionId = await registerStartedWorker(worker, workers, request.resumeSessionId);
	return respond({ session: sessionSummaries(workers).find((session) => session.sessionId === sessionId) });
}

/**
 * Reopen the sessions this server's workers owned when it stopped. A resumed
 * worker continues an interrupted run on its own (`continueRestoredSession`).
 */
export async function restoreOwnedSessions(workers: Map<string, Worker>): Promise<void> {
	for (const { sessionId, cwd } of readOwnedSessions()) {
		// A client may have reopened it while an earlier one was restoring.
		if (workers.has(sessionId)) continue;
		try {
			const resumePath = sessionPathForId(sessionId);
			if (!resumePath) throw new Error("it is not in the session directory");
			const listed = sessionSummaries(workers).find((session) => session.sessionId === sessionId);
			if (listed && listed.status !== "ended") throw new Error("it has a live writer");
			await registerStartedWorker(startWorker(cwd, resumePath), workers, sessionId);
		} catch (error) {
			if (!workers.has(sessionId)) forgetOwnedSession(sessionId);
			console.error(`pi server: not reopening session ${sessionId}: ${errorMessage(error)}`);
		}
	}
}

async function handleStopSession({ frame, workers, respond, fail }: CommandContext): Promise<void> {
	const worker = workers.get(String(frame.sessionId));
	if (!worker) return fail("not_managed", "Session is not owned by this server");
	if (frame.runtimeInstanceId !== worker.runtimeInstanceId)
		return fail("stale_runtime", "Runtime instance ID does not match");
	const running = sessionSummaries(workers).find((session) => session.sessionId === worker.sessionId);
	workers.delete(worker.sessionId);
	forgetOwnedSession(worker.sessionId);
	if (worker.child.exitCode === null && worker.child.signalCode === null) {
		const exited = new Promise<void>((resolve) => worker.child.once("exit", () => resolve()));
		worker.child.stdin?.end();
		await exited;
	}
	const ended = sessionSummaries(workers).find((session) => session.sessionId === worker.sessionId);
	if (ended) return respond({ session: ended });
	// A session with no persisted transcript leaves the directory when its worker exits:
	// report its last directory entry, now ended and no longer owned.
	if (!running) return fail("not_found", "Stopped session is not in the session directory");
	const { runtimeInstanceId: _released, ...last } = running;
	return respond({ session: { ...last, status: "ended", owner: "external", attachment: "none" } });
}

/** Deletes an ended session and its sub-agent transcripts, as `pi -r` does (trash first, else unlink). */
async function handleDeleteSession({ frame, workers, publishUpdates, respond, fail }: CommandContext): Promise<void> {
	const session = sessionSummaries(workers).find((entry) => entry.sessionId === frame.sessionId);
	if (!session?.sessionPath) return fail("not_found", "Session is not in the session directory");
	if (session.status !== "ended") return fail("running", "Stop the session before deleting it");
	const result = await deleteSessionTree(session.sessionPath, getControlDbPath());
	if (!result.ok) return fail("delete_failed", result.error);
	publishUpdates();
	return respond({ sessionId: session.sessionId });
}

async function handleAttachSession({ frame, client, workers, respond, fail }: CommandContext): Promise<void> {
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
			client.send({
				type: "session_event",
				sessionId: worker.sessionId,
				runtimeInstanceId: worker.runtimeInstanceId,
				...event,
			});
	}
	attachment.events = [];
	return respond({
		session: sessionSummaries(workers).find((session) => session.sessionId === worker.sessionId),
		runtimeInstanceId: worker.runtimeInstanceId,
		firstSequence,
		mode: frame.mode,
		snapshot,
	});
}

async function handleDetachSession({ frame, client, workers, respond, fail }: CommandContext): Promise<void> {
	const worker = workers.get(String(frame.sessionId));
	const attachment = client.attachments.get(String(frame.sessionId));
	if (!worker || !attachment) return fail("not_attached", "Client is not attached to this session");
	if (frame.runtimeInstanceId !== worker.runtimeInstanceId)
		return fail("stale_runtime", "Runtime instance ID does not match");
	client.attachments.delete(worker.sessionId);
	worker.clients.delete(client);
	return respond({ detached: true });
}

async function handleSessionRpc({ frame, client, workers, respond, fail }: CommandContext): Promise<void> {
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
	if (command.type === "extension_ui_response") {
		await writeWorkerLine(worker, command);
		return respond({
			response: { type: "response", command: "extension_ui_response", success: true, id: command.id },
		});
	}
	const response = await rpcCommand(worker, command);
	return respond({ response: { ...response, id: command.id } });
}

async function handleListQuestions({
	frame,
	client,
	workers,
	revisions,
	publishUpdates,
	hub,
	respond,
}: CommandContext) {
	publishUpdates();
	client.subscriptions.add("questions");
	const questions = withMachines(questionSummaries(workers), frame, hub, (machines) => machines.cachedQuestions());
	return respond({ questions, revision: revisions.questions });
}

async function handleListMachines({ client, hub, respond, fail }: CommandContext) {
	if (!hub) return fail("not_hub", "This server is not the hub");
	client.subscriptions.add("machines");
	return respond({ machines: hub.machines() });
}

const commandHandlers: Record<string, CommandHandler> = {
	hello: handleHello,
	list_sessions: handleListSessions,
	start_session: handleStartSession,
	stop_session: handleStopSession,
	delete_session: handleDeleteSession,
	rename_session: handleRenameSession,
	archive_session: handleArchiveSession,
	attach_session: handleAttachSession,
	detach_session: handleDetachSession,
	session_rpc: handleSessionRpc,
	list_questions: handleListQuestions,
	answer_question: handleAnswerQuestion,
	list_machines: handleListMachines,
};

/** Runs one client frame: forwards it to a spoke when its hostId names one, otherwise handles it here. */
export async function handleCommand(frame: Record<string, unknown>, client: Client, state: ServerState): Promise<void> {
	const type = frame.type;
	const respond = (data: unknown) =>
		client.send({ type: "response", id: frame.id, command: type, success: true, data });
	const fail = (code: string, message: string) =>
		client.send({ type: "response", id: frame.id, command: type, success: false, error: { code, message } });
	const { hub } = state;
	if (frame.hostId !== undefined && frame.hostId !== (hub?.hostId ?? serverHostId())) {
		if (!hub || !client.hubClient) return fail("not_hub", "Only the hub forwards frames to other machines");
		if (!hub.forward(client.hubClient, frame))
			return fail("machine_offline", `Machine ${String(frame.hostId)} is offline`);
		if (type === "list_sessions") client.subscriptions.add("sessions");
		if (type === "list_questions") client.subscriptions.add("questions");
		return;
	}
	const handler = Object.hasOwn(commandHandlers, String(type)) ? commandHandlers[String(type)] : undefined;
	if (!handler) return fail("unknown_command", `Unknown server command: ${String(type)}`);
	try {
		await handler({ ...state, frame, client, respond, fail });
	} catch (error) {
		return fail("server_error", errorMessage(error));
	}
}

/** Drops a closed client's attachments; its workers keep running. */
export function releaseClient(client: Client, workers: Map<string, Worker>): void {
	for (const sessionId of client.attachments.keys()) workers.get(sessionId)?.clients.delete(client);
	client.attachments.clear();
}
