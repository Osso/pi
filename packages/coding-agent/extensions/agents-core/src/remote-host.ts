import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import { defaultHubCommand, readFrames, serverHostId, socketPath, writeFrame } from "../../../src/cli/server-wire.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";

type Frame = Record<string, unknown>;
type PendingRequest = { resolve: (data: Frame) => void; reject: (error: Error) => void };

/** One pi server protocol connection to the hub, which routes frames by hostId to another machine. */
export class HubConnection {
	private readonly output: Writable;
	private readonly destroy: () => void;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly frameListeners = new Set<(frame: Frame) => void>();
	private readonly closeListeners = new Set<(error: Error) => void>();
	private nextId = 0;
	closed: Error | undefined;

	constructor(input: Readable, output: Writable, destroy: () => void) {
		this.output = output;
		this.destroy = destroy;
		readFrames(
			input,
			(frame) => this.accept(frame),
			() => this.fail(new Error("Invalid frame from pi server hub")),
		);
		input.once("close", () => this.fail(new Error("Connection to pi server hub closed")));
		input.once("error", (error) => this.fail(new Error(`Pi server hub connection failed: ${error.message}`)));
	}

	static async open(ctx: ExtensionContext): Promise<HubConnection> {
		const server = ctx.settingsManager?.getMergedSettings().server;
		if (!server?.hub) throw new Error("Remote host requires server.hub in settings");
		let connection: HubConnection;
		if (server.hub === serverHostId()) {
			const socket = createConnection(socketPath());
			connection = new HubConnection(socket, socket, () => socket.destroy());
		} else {
			const [program, ...args] = server.hubCommand ?? defaultHubCommand(server.hub);
			if (!program) throw new Error("server.hubCommand is empty");
			const child = spawn(program, args, { stdio: ["pipe", "pipe", "ignore"] });
			connection = new HubConnection(child.stdout, child.stdin, () => child.kill("SIGTERM"));
		}
		try {
			await connection.request("hello", { version: 1 });
		} catch (error) {
			connection.close();
			throw error;
		}
		return connection;
	}

	request(type: string, fields: Frame): Promise<Frame> {
		if (this.closed) return Promise.reject(this.closed);
		const id = `remote-host-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			writeFrame(this.output, { ...fields, type, id });
		});
	}

	onFrame(listener: (frame: Frame) => void): void {
		this.frameListeners.add(listener);
	}

	onClose(listener: (error: Error) => void): void {
		if (this.closed) listener(this.closed);
		else this.closeListeners.add(listener);
	}

	close(): void {
		this.fail(new Error("Connection to pi server hub closed"));
		this.destroy();
	}

	private accept(frame: Frame): void {
		if (frame.type !== "response") {
			for (const listener of this.frameListeners) listener(frame);
			return;
		}
		const id = String(frame.id);
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		const error = frame.error as { code?: string; message?: string } | undefined;
		if (frame.success === true) pending.resolve((frame.data ?? {}) as Frame);
		else pending.reject(new Error(`${String(frame.command)} failed: ${error?.code}: ${error?.message}`));
	}

	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = error;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		for (const listener of this.closeListeners) listener(error);
		this.closeListeners.clear();
	}
}

/** Validates and trims a host ID while keeping caller-specific errors. */
export function normalizeRemoteHost(host: unknown, caller: string): string | undefined {
	if (host === undefined) return undefined;
	if (typeof host !== "string" || !host.trim())
		throw new Error(`${caller} host must be a non-empty pi server host ID`);
	return host.trim();
}

interface RemoteToolSession {
	sessionId: string;
	runtimeInstanceId: string;
}

async function startRemoteToolSession(hub: HubConnection, host: string, cwd: string): Promise<RemoteToolSession> {
	const started = await hub.request("start_session", { hostId: host, cwd });
	const startedSession = started.session as Frame | undefined;
	const sessionId = String(startedSession?.sessionId ?? "");
	const runtimeInstanceId = String(startedSession?.runtimeInstanceId ?? "");
	if (!sessionId || !runtimeInstanceId) throw new Error(`Could not start a session on host ${host}`);
	try {
		const attached = await hub.request("attach_session", { hostId: host, sessionId, mode: "control" });
		const attachedRuntimeId = String(attached.runtimeInstanceId ?? "");
		if (!attachedRuntimeId) throw new Error(`Could not attach to a session on host ${host}`);
		return { sessionId, runtimeInstanceId: attachedRuntimeId };
	} catch (error) {
		await stopRemoteToolSession(hub, host, { sessionId, runtimeInstanceId });
		throw error;
	}
}

async function callRemoteToolOnSession(
	hub: HubConnection,
	host: string,
	session: RemoteToolSession,
	toolName: string,
	params: unknown,
): Promise<unknown> {
	const response = await hub.request("session_rpc", {
		hostId: host,
		sessionId: session.sessionId,
		runtimeInstanceId: session.runtimeInstanceId,
		command: { type: "call_tool", toolName, params },
	});
	const rpcResponse = (response.response ?? {}) as Frame;
	if (rpcResponse.success !== true)
		throw new Error(`Remote ${toolName} failed on ${host}: ${String(rpcResponse.error)}`);
	return (rpcResponse.data as { result?: unknown } | undefined)?.result;
}

async function stopRemoteToolSession(hub: HubConnection, host: string, session: RemoteToolSession): Promise<void> {
	try {
		await hub.request("stop_session", {
			hostId: host,
			sessionId: session.sessionId,
			runtimeInstanceId: session.runtimeInstanceId,
		});
	} catch (error) {
		console.error(`Failed to stop remote tool session ${session.sessionId} on ${host}:`, error);
	}
}

/** Runs an active tool on another pi-server host. Undefined means the requested host is local. */
export async function runRemoteTool(
	ctx: ExtensionContext,
	host: string | undefined,
	cwd: string,
	toolName: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<unknown | undefined> {
	const target = normalizeRemoteHost(host, toolName);
	if (!target || target === serverHostId()) return undefined;
	if (signal?.aborted) throw new Error("Remote tool call aborted");

	const hub = await HubConnection.open(ctx);
	let session: RemoteToolSession | undefined;
	try {
		session = await startRemoteToolSession(hub, target, cwd);
		if (signal?.aborted) throw new Error("Remote tool call aborted");
		return await callRemoteToolOnSession(hub, target, session, toolName, params);
	} finally {
		if (session) await stopRemoteToolSession(hub, target, session);
		hub.close();
	}
}
