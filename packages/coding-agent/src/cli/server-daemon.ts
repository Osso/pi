import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { getAgentDir } from "../config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import {
	type Client,
	handleCommand,
	PROTOCOL_VERSION,
	type RevisionCounters,
	releaseClient,
	restoreOwnedSessions,
	type ServerState,
	type Subscription,
	type Worker,
} from "./server-command.ts";
import { type HubLink, ServerHub } from "./server-hub.ts";
import { removeStaleSocket } from "./server-launch.ts";
import { questionUpdates } from "./server-question-utils.ts";
import { startSpokeLink } from "./server-spoke-link.ts";
import { errorMessage, readFrames, serverHostId, socketPath, writeFrame } from "./server-wire.ts";
import { sessionSummaries } from "./server-worker.ts";

const SERVER_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

/**
 * Default spoke link. A non-interactive SSH shell often lacks ~/.local/bin on PATH, so the remote pi is named by
 * its install path; the remote shell expands `~`. Set `server.hubCommand` when pi is installed elsewhere.
 */
export function defaultHubCommand(hub: string): string[] {
	return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", hub, "~/.local/bin/pi", "server", "--link"];
}

function broadcast(clients: Set<Client>, subscription: Subscription, frames: unknown[]): void {
	for (const client of clients) {
		if (client.subscriptions.has(subscription)) for (const frame of frames) client.send(frame);
	}
}

/** Returns a function that emits session and question changes since its previous call to subscribed clients. */
function createUpdatePublisher(
	workers: Map<string, Worker>,
	clients: Set<Client>,
	revisions: RevisionCounters,
): () => void {
	let previousSessions = new Map<string, string>();
	let previousQuestions = new Map<string, string>();
	return () => {
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
			for (const [questionId, value] of previousQuestions) {
				const previous = JSON.parse(value) as Record<string, unknown>;
				// A pending question that leaves without an answer record (its dialog was dismissed or its worker
				// ended) is reported cancelled, or clients and the hub keep it pending forever.
				if (!currentQuestions.has(questionId) && previous.state === "pending")
					questionEvents.push({
						type: "question_updated",
						revision: ++revisions.questions,
						question: { ...previous, state: "cancelled", answerable: false },
					});
			}
			broadcast(clients, "sessions", sessionEvents);
			broadcast(clients, "questions", questionEvents);
			previousSessions = currentSessions;
			previousQuestions = currentQuestions;
		} catch (error) {
			console.error(`pi server update: ${errorMessage(error)}`);
		}
	};
}

/** The client subscription that receives a hub-wide event. */
function hubEventScope(frame: Record<string, unknown>): Subscription | undefined {
	if (frame.type === "machine_updated") return "machines";
	if (frame.type === "session_updated" || frame.type === "session_removed") return "sessions";
	if (frame.type === "question_updated") return "questions";
	if (frame.type === "resync_required" && (frame.scope === "sessions" || frame.scope === "questions"))
		return frame.scope;
	return undefined;
}

function registerLink(
	frame: Record<string, unknown>,
	send: (frame: unknown) => void,
	hub: ServerHub | undefined,
): HubLink | undefined {
	const reject = (code: string, message: string) => {
		send({ type: "link_hello_rejected", error: { code, message } });
		return undefined;
	};
	if (!hub) return reject("not_hub", "This server is not the hub");
	if (
		frame.version !== PROTOCOL_VERSION ||
		typeof frame.hostId !== "string" ||
		!frame.hostId ||
		typeof frame.serverInstanceId !== "string"
	)
		return reject("invalid_link_hello", "version 1, hostId, and serverInstanceId are required");
	if (frame.hostId === hub.hostId) return reject("invalid_link_hello", "A spoke cannot use the hub's host ID");
	const link = hub.register(frame.hostId, frame.serverInstanceId, send);
	if (!link) return reject("duplicate_host", `A live link already exists for ${frame.hostId}`);
	send({ type: "link_hello_ack", version: PROTOCOL_VERSION, hostId: hub.hostId });
	return link;
}

/** Serves one socket: a protocol client, or on the hub, a spoke link once its first frame is link_hello. */
function acceptConnection(socket: Socket, state: ServerState, clients: Set<Client>): void {
	const { hub } = state;
	const send = (frame: unknown) => writeFrame(socket, frame);
	const client: Client = { send, attachments: new Map(), subscriptions: new Set() };
	if (hub) client.hubClient = hub.addClient(send);
	clients.add(client);
	let link: HubLink | undefined;
	const releaseProtocolClient = () => {
		clients.delete(client);
		if (client.hubClient) hub?.removeClient(client.hubClient);
		releaseClient(client, state.workers);
	};
	const onFrame = (frame: Record<string, unknown>) => {
		if (link) return hub?.accept(link, frame);
		if (frame.type !== "link_hello") return void handleCommand(frame, client, state);
		link = registerLink(frame, send, hub);
		if (link) releaseProtocolClient();
		else socket.end();
	};
	readFrames(socket, onFrame, () =>
		send({ type: "response", success: false, error: { code: "invalid_json", message: "Invalid JSON frame" } }),
	);
	socket.on("error", (error) => console.error(`pi server connection: ${errorMessage(error)}`));
	socket.on("close", () => {
		if (link) hub?.disconnect(link);
		else releaseProtocolClient();
	});
}

/** On a spoke: one local client per hub connection, carried over the outbound link. */
function startHubLink(command: string[], state: ServerState, clients: Set<Client>): () => void {
	return startSpokeLink<Client>(
		command,
		{
			type: "link_hello",
			version: PROTOCOL_VERSION,
			hostId: serverHostId(),
			serverInstanceId: state.serverInstanceId,
		},
		{
			createClient: (send) => {
				const client: Client = { send, attachments: new Map(), subscriptions: new Set() };
				clients.add(client);
				return client;
			},
			dropClient: (client) => {
				clients.delete(client);
				releaseClient(client, state.workers);
			},
			handle: (frame, client) => void handleCommand(frame, client, state),
		},
	);
}

export async function runStdioConnector(path: string): Promise<void> {
	const socket = createConnection(path);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
	await new Promise<void>((resolve) => socket.once("close", resolve));
}

export async function runServer(): Promise<void> {
	const path = socketPath();
	const settings = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
	const serverSettings = settings.getMergedSettings().server;
	const hubName = serverSettings?.hub;
	const hub = hubName === serverHostId() ? new ServerHub() : undefined;
	mkdirSync(dirname(path), { recursive: true, mode: SERVER_DIR_MODE });
	chmodSync(dirname(path), SERVER_DIR_MODE);
	await removeStaleSocket(path);
	const workers = new Map<string, Worker>();
	const clients = new Set<Client>();
	const revisions: RevisionCounters = { sessions: 0, questions: 0 };
	const state: ServerState = {
		workers,
		serverInstanceId: crypto.randomUUID(),
		revisions,
		publishUpdates: createUpdatePublisher(workers, clients, revisions),
		hub,
	};
	hub?.addListener((frame) => {
		const scope = hubEventScope(frame);
		if (scope) broadcast(clients, scope, [frame]);
	});
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		acceptConnection(socket, state, clients);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});
	chmodSync(path, SOCKET_MODE);
	const updateTimer = setInterval(state.publishUpdates, 500);
	restoreOwnedSessions(workers).catch((error) =>
		console.error(`pi server: reopening owned sessions failed: ${errorMessage(error)}`),
	);
	const stopHubLink =
		hubName && !hub
			? startHubLink(serverSettings?.hubCommand ?? defaultHubCommand(hubName), state, clients)
			: undefined;
	const close = () => {
		stopHubLink?.();
		clearInterval(updateTimer);
		for (const worker of workers.values()) worker.child.kill("SIGTERM");
		server.close();
		for (const socket of sockets) socket.destroy();
		rmSync(path, { force: true });
	};
	process.once("SIGTERM", close);
	process.once("SIGINT", close);
	await new Promise<void>((resolve) => server.once("close", resolve));
}

/** Runs `pi server`, the SSH stdio connector (`--stdio`), or the hub link endpoint (`--link`). */
export async function handleServerCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "server") return false;
	try {
		if (args.length === 2 && (args[1] === "--stdio" || args[1] === "--link")) await runStdioConnector(socketPath());
		else if (args.length === 1) await runServer();
		else throw new Error("Usage: pi server [--stdio|--link]");
	} catch (error) {
		console.error(`pi server: ${errorMessage(error)}`);
		process.exitCode = 1;
	}
	return true;
}
