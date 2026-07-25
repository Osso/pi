import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

export function getSupervisorRequestSocketPath(controlDbPath: string): string {
	return `${controlDbPath}.supervisor.sock`;
}

export function notifySupervisorRequest(controlDbPath: string): void {
	assertUnixSocketSupport();
	const socket = createConnection(getSupervisorRequestSocketPath(controlDbPath));
	socket.once("connect", () => socket.end());
	socket.once("error", () => socket.destroy());
	socket.unref();
}

export class SupervisorRequestWakeServer {
	readonly socketPath: string;
	private readonly clients = new Set<Socket>();
	private readonly removeSocketOnExit = () => this.removeSocketFile();
	private readonly waiters = new Set<() => void>();
	private generation = 0;
	private server?: Server;

	constructor(controlDbPath: string) {
		this.socketPath = getSupervisorRequestSocketPath(controlDbPath);
	}

	async start(): Promise<void> {
		assertUnixSocketSupport();
		if (this.server) return;
		mkdirSync(dirname(this.socketPath), { mode: 0o700, recursive: true });
		const server = await listenWithStaleSocketRecovery(this.socketPath, (socket) => this.acceptClient(socket));
		this.server = server;
		process.once("exit", this.removeSocketOnExit);
		chmodSync(this.socketPath, 0o600);
	}

	currentGeneration(): number {
		return this.generation;
	}

	waitForWakeAfter(observedGeneration: number, signal: AbortSignal): Promise<void> {
		if (signal.aborted || this.generation > observedGeneration) return Promise.resolve();
		return new Promise((resolve) => {
			let settled = false;
			const done = () => {
				if (settled) return;
				settled = true;
				this.waiters.delete(done);
				signal.removeEventListener("abort", done);
				resolve();
			};
			this.waiters.add(done);
			signal.addEventListener("abort", done, { once: true });
			if (signal.aborted || this.generation > observedGeneration) done();
		});
	}

	async close(): Promise<void> {
		process.off("exit", this.removeSocketOnExit);
		for (const waiter of [...this.waiters]) waiter();
		for (const client of this.clients) client.destroy();
		this.clients.clear();
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
			});
		}
		this.removeSocketFile();
	}

	private acceptClient(socket: Socket): void {
		this.clients.add(socket);
		socket.once("close", () => this.clients.delete(socket));
		socket.once("error", () => socket.destroy());
		this.generation += 1;
		for (const waiter of [...this.waiters]) waiter();
		socket.end();
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
		if (!hasErrorCode(error, "EADDRINUSE")) throw error;
		if (await socketAcceptsConnections(socketPath)) {
			throw new Error(`Supervisor request socket is already active: ${socketPath}`);
		}
		rmSync(socketPath, { force: true });
		return listenOnSocket(socketPath, onConnection);
	}
}

function listenOnSocket(socketPath: string, onConnection: (socket: Socket) => void): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer(onConnection);
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve(server);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(socketPath);
	});
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		const finish = (accepting: boolean) => {
			socket.destroy();
			resolve(accepting);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", (error) => {
			if (hasErrorCode(error, "ECONNREFUSED") || hasErrorCode(error, "ENOENT")) finish(false);
			else reject(error);
		});
		socket.unref();
	});
}

function assertUnixSocketSupport(): void {
	if (process.platform === "win32") {
		throw new Error("Supervisor request wake requires Unix domain sockets");
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
