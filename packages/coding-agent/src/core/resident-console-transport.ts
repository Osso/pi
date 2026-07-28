import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

export const RESIDENT_CONSOLE_PROTOCOL_VERSION = 1;
export type ResidentConsoleService = "architect" | "supervisor";

export interface ResidentConsoleSnapshot<Entry> {
	service: ResidentConsoleService;
	sessionId: string;
	cwd: string;
	generation: number;
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
		if (message.version !== RESIDENT_CONSOLE_PROTOCOL_VERSION) {
			this.sendError(socket, "version_mismatch", "Resident console protocol version mismatch");
			return;
		}
		if (message.service !== this.options.service) {
			this.sendError(socket, "service_mismatch", "Resident console service mismatch");
			return;
		}
		if (this.owner) {
			this.sendError(socket, "owner_exists", "Resident console already has a writable client");
			return;
		}
		const snapshot = this.options.getSnapshot();
		this.owner = socket;
		this.write(socket, { type: "attached", version: RESIDENT_CONSOLE_PROTOCOL_VERSION, ...snapshot });
		this.unsubscribe = this.options.subscribe((event) => {
			this.sequence += 1;
			this.write(socket, { type: "event", sequence: this.sequence, event });
		});
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
