import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

export const RESIDENT_CONSOLE_PROTOCOL_VERSION = 1;
export type ResidentConsoleService = "architect" | "supervisor";

export interface ResidentConsoleIdentity {
	version: string;
	pid: number;
	executable: string;
	entrypoint?: string;
	instanceId: string;
	managedBy: "external" | "pi";
	ready: true;
}

export interface ResidentConsoleSnapshot<Entry> {
	service: ResidentConsoleService;
	sessionId: string;
	cwd: string;
	generation: number;
	identity?: ResidentConsoleIdentity;
	branch: Entry[];
}

export interface ResidentConsoleServerOptions<Entry, Event> {
	socketPath: string;
	service: ResidentConsoleService;
	getSnapshot: () => ResidentConsoleSnapshot<Entry>;
	enqueuePrompt: (text: string, id: string) => Promise<void> | void;
	subscribe: (listener: (event: Event) => void) => () => void;
}

type ClientMessage =
	| { type: "attach"; version: number; service: ResidentConsoleService }
	| { type: "probe"; version: number; service: ResidentConsoleService }
	| { type: "prompt"; id: string; text: string }
	| { type: "disconnect" };

export class ResidentConsoleServer<Entry, Event> {
	readonly socketPath: string;
	private readonly options: ResidentConsoleServerOptions<Entry, Event>;
	private readonly sockets = new Set<Socket>();
	private readonly removeSocketOnExit = () => this.removeSocketFile();
	private server?: Server;
	private owner?: Socket;
	private unsubscribe?: () => void;
	private sequence = 0;

	constructor(options: ResidentConsoleServerOptions<Entry, Event>) {
		this.options = options;
		this.socketPath = options.socketPath;
	}

	async start(): Promise<void> {
		if (process.platform === "win32") throw new Error("Resident console requires Unix domain sockets");
		if (this.server) return;
		mkdirSync(dirname(this.socketPath), { mode: 0o700, recursive: true });
		this.server = await listenWithStaleSocketRecovery(this.socketPath, (socket) => this.acceptSocket(socket));
		chmodSync(this.socketPath, 0o600);
		process.once("exit", this.removeSocketOnExit);
	}

	async close(): Promise<void> {
		process.off("exit", this.removeSocketOnExit);
		this.releaseOwner();
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		const server = this.server;
		this.server = undefined;
		if (server)
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		this.removeSocketFile();
	}

	private acceptSocket(socket: Socket): void {
		this.sockets.add(socket);
		let buffer = "";
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				try {
					this.handleMessage(socket, JSON.parse(line) as ClientMessage);
				} catch {
					this.sendError(socket, "invalid_message", "Invalid resident console message");
				}
			}
		};
		socket.on("data", onData);
		socket.once("close", () => {
			socket.off("data", onData);
			this.sockets.delete(socket);
			if (this.owner === socket) this.releaseOwner();
		});
		socket.once("error", () => socket.destroy());
	}

	private handleMessage(socket: Socket, message: ClientMessage): void {
		if (message.type === "attach") {
			this.attach(socket, message);
			return;
		}
		if (message.type === "probe") {
			this.probe(socket, message);
			return;
		}
		if (this.owner !== socket) {
			this.sendError(socket, "missing_attach", "Resident console attach is required");
			return;
		}
		if (message.type === "disconnect") {
			socket.end();
			return;
		}
		if (message.type !== "prompt" || !message.id || !message.text) {
			this.sendError(socket, "invalid_message", "Invalid resident console message");
			return;
		}
		void this.enqueuePrompt(socket, message.id, message.text);
	}

	private attach(socket: Socket, message: Extract<ClientMessage, { type: "attach" }>): void {
		if (!this.validateRequest(socket, message)) return;
		if (this.owner) {
			const previousOwner = this.owner;
			this.releaseOwner();
			previousOwner.end();
		}
		const snapshot = this.options.getSnapshot();
		this.owner = socket;
		this.write(socket, { type: "attached", version: RESIDENT_CONSOLE_PROTOCOL_VERSION, ...snapshot });
		this.unsubscribe = this.options.subscribe((event) => {
			this.sequence += 1;
			this.write(socket, { type: "event", sequence: this.sequence, event });
		});
	}

	private probe(socket: Socket, message: Extract<ClientMessage, { type: "probe" }>): void {
		if (!this.validateRequest(socket, message)) return;
		this.write(socket, { type: "probed", version: RESIDENT_CONSOLE_PROTOCOL_VERSION, ...this.options.getSnapshot() });
	}

	private validateRequest(socket: Socket, message: Extract<ClientMessage, { type: "attach" | "probe" }>): boolean {
		if (message.version !== RESIDENT_CONSOLE_PROTOCOL_VERSION) {
			this.sendError(socket, "version_mismatch", "Resident console protocol version mismatch");
			return false;
		}
		if (message.service !== this.options.service) {
			this.sendError(socket, "service_mismatch", "Resident console service mismatch");
			return false;
		}
		return true;
	}

	private async enqueuePrompt(socket: Socket, id: string, text: string): Promise<void> {
		try {
			await this.options.enqueuePrompt(text, id);
			this.write(socket, { type: "prompt_accepted", id });
		} catch (error) {
			this.sendError(socket, "prompt_rejected", error instanceof Error ? error.message : String(error), id);
		}
	}

	private releaseOwner(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.owner = undefined;
	}

	private sendError(socket: Socket, code: string, message: string, id?: string): void {
		this.write(socket, { type: "error", code, message, id });
	}

	private write(socket: Socket, message: object): void {
		if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
	}

	private removeSocketFile(): void {
		if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
	}
}

export interface ResidentConsoleEvent<Event> {
	sequence: number;
	event: Event;
}

interface PendingPrompt {
	resolve: () => void;
	reject: (error: Error) => void;
}

export class ResidentConsoleClient<Entry, Event> {
	readonly snapshot: ResidentConsoleSnapshot<Entry>;
	private readonly socket: Socket;
	private readonly pendingPrompts = new Map<string, PendingPrompt>();
	private readonly listeners = new Set<(event: ResidentConsoleEvent<Event>) => void>();
	private readonly closeListeners = new Set<(error?: Error) => void>();
	private buffer = "";
	private closed = false;

	private constructor(socket: Socket, snapshot: ResidentConsoleSnapshot<Entry>, remainingBuffer: string) {
		this.socket = socket;
		this.snapshot = snapshot;
		this.buffer = remainingBuffer;
		this.socket.on("data", this.onData);
		this.socket.once("close", this.onClose);
		this.socket.once("error", this.onError);
		if (this.buffer) queueMicrotask(() => this.consumeBuffer());
	}

	static async connect<Entry, Event>(options: {
		socketPath: string;
		service: ResidentConsoleService;
	}): Promise<ResidentConsoleClient<Entry, Event>> {
		if (process.platform === "win32") throw new Error("Resident console requires Unix domain sockets");
		const socket = await connectResidentConsole(options.socketPath);
		try {
			const attached = await readResidentConsoleSnapshot<Entry>(socket, options.service, "attach");
			return new ResidentConsoleClient<Entry, Event>(socket, attached.snapshot, attached.remainingBuffer);
		} catch (error) {
			socket.destroy();
			throw error;
		}
	}

	prompt(id: string, text: string): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Resident console is closed"));
		if (!id || !text) return Promise.reject(new Error("Resident console prompt id and text are required"));
		if (this.pendingPrompts.has(id))
			return Promise.reject(new Error(`Resident console prompt already pending: ${id}`));
		return new Promise((resolve, reject) => {
			this.pendingPrompts.set(id, { resolve, reject });
			this.write({ type: "prompt", id, text });
		});
	}

	onEvent(listener: (event: ResidentConsoleEvent<Event>) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onDisconnect(listener: (error?: Error) => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.write({ type: "disconnect" });
		this.socket.end();
		await new Promise<void>((resolve) => this.socket.once("close", resolve));
	}

	private readonly onData = (chunk: Buffer): void => {
		this.buffer += chunk.toString("utf8");
		this.consumeBuffer();
	};

	private readonly onClose = (): void => this.finish();
	private readonly onError = (error: Error): void => this.finish(error);

	private consumeBuffer(): void {
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			try {
				this.handleMessage(JSON.parse(line) as Record<string, unknown>);
			} catch {
				this.finish(new Error("Invalid resident console response"));
			}
		}
	}

	private handleMessage(message: Record<string, unknown>): void {
		if (message.type === "event" && typeof message.sequence === "number" && "event" in message) {
			const event = { sequence: message.sequence, event: message.event as Event };
			for (const listener of this.listeners) listener(event);
			return;
		}
		if ((message.type === "prompt_accepted" || message.type === "error") && typeof message.id === "string") {
			const pending = this.pendingPrompts.get(message.id);
			if (!pending) return;
			this.pendingPrompts.delete(message.id);
			if (message.type === "prompt_accepted") pending.resolve();
			else
				pending.reject(
					new Error(typeof message.message === "string" ? message.message : "Resident prompt rejected"),
				);
		}
	}

	private finish(error?: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.socket.off("data", this.onData);
		const failure = error ?? new Error("Resident console disconnected");
		for (const pending of this.pendingPrompts.values()) pending.reject(failure);
		this.pendingPrompts.clear();
		for (const listener of this.closeListeners) listener(error);
	}

	private write(message: object): void {
		if (!this.socket.destroyed) this.socket.write(`${JSON.stringify(message)}\n`);
	}
}

export async function probeResidentConsole<Entry>(options: {
	socketPath: string;
	service: ResidentConsoleService;
}): Promise<ResidentConsoleSnapshot<Entry>> {
	if (process.platform === "win32") throw new Error("Resident console requires Unix domain sockets");
	const socket = await connectResidentConsole(options.socketPath);
	try {
		const probed = await readResidentConsoleSnapshot<Entry>(socket, options.service, "probe");
		return probed.snapshot;
	} finally {
		socket.destroy();
	}
}

async function readResidentConsoleSnapshot<Entry>(
	socket: Socket,
	service: ResidentConsoleService,
	type: "attach" | "probe",
): Promise<{ snapshot: ResidentConsoleSnapshot<Entry>; remainingBuffer: string }> {
	socket.write(`${JSON.stringify({ type, version: RESIDENT_CONSOLE_PROTOCOL_VERSION, service })}\n`);
	const response = await readResidentConsoleLine(socket);
	if (response.message.type === "error") {
		throw new Error(
			typeof response.message.message === "string" ? response.message.message : "Resident console request failed",
		);
	}
	return {
		snapshot: parseResidentConsoleSnapshot<Entry>(response.message, service),
		remainingBuffer: response.remainingBuffer,
	};
}

function parseResidentConsoleSnapshot<Entry>(
	message: Record<string, unknown>,
	service: ResidentConsoleService,
): ResidentConsoleSnapshot<Entry> {
	if (
		(message.type !== "attached" && message.type !== "probed") ||
		message.version !== RESIDENT_CONSOLE_PROTOCOL_VERSION ||
		message.service !== service ||
		typeof message.sessionId !== "string" ||
		typeof message.cwd !== "string" ||
		typeof message.generation !== "number" ||
		!Array.isArray(message.branch)
	) {
		throw new Error("Invalid resident console response");
	}
	const identity = readResidentConsoleIdentity(message.identity);
	if (message.identity !== undefined && !identity) throw new Error("Invalid resident console identity");
	return {
		service,
		sessionId: message.sessionId,
		cwd: message.cwd,
		generation: message.generation,
		...(identity ? { identity } : {}),
		branch: message.branch as Entry[],
	};
}

function readResidentConsoleIdentity(value: unknown): ResidentConsoleIdentity | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return undefined;
	if (
		typeof value.version !== "string" ||
		typeof value.pid !== "number" ||
		typeof value.executable !== "string" ||
		typeof value.instanceId !== "string" ||
		(value.managedBy !== "external" && value.managedBy !== "pi") ||
		value.ready !== true ||
		(value.entrypoint !== undefined && typeof value.entrypoint !== "string")
	) {
		return undefined;
	}
	return {
		version: value.version,
		pid: value.pid,
		executable: value.executable,
		...(value.entrypoint !== undefined ? { entrypoint: value.entrypoint } : {}),
		instanceId: value.instanceId,
		managedBy: value.managedBy,
		ready: true,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readResidentConsoleLine(
	socket: Socket,
): Promise<{ message: Record<string, unknown>; remainingBuffer: string }> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const cleanup = () => {
			socket.off("data", onData);
			socket.off("close", onClose);
			socket.off("error", onError);
		};
		const onClose = () => {
			cleanup();
			reject(new Error("Resident console disconnected before attach"));
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			cleanup();
			try {
				resolve({
					message: JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>,
					remainingBuffer: buffer.slice(newline + 1),
				});
			} catch {
				reject(new Error("Invalid resident console attach response"));
			}
		};
		socket.on("data", onData);
		socket.once("close", onClose);
		socket.once("error", onError);
	});
}

function connectResidentConsole(socketPath: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => resolve(socket));
		socket.once("error", (error) => {
			socket.destroy();
			if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
				reject(new Error(`Resident console is unavailable: ${socketPath}`));
				return;
			}
			reject(error);
		});
	});
}

async function listenWithStaleSocketRecovery(
	socketPath: string,
	onConnection: (socket: Socket) => void,
): Promise<Server> {
	try {
		return await listenOnSocket(socketPath, onConnection);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
		if (await socketAcceptsConnections(socketPath))
			throw new Error(`Resident console socket is already active: ${socketPath}`);
		rmSync(socketPath, { force: true });
		return listenOnSocket(socketPath, onConnection);
	}
}

function listenOnSocket(socketPath: string, onConnection: (socket: Socket) => void): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer(onConnection);
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve(server);
		});
	});
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
	});
}
