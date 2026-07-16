import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import * as repl from "node:repl";
import { runInNewContext } from "node:vm";

interface DebugRuntime {
	readonly session: unknown;
	readonly services?: unknown;
}

interface DebugReplServerOptions {
	agentDir: string;
	getRuntime: () => DebugRuntime;
	getStore?: () => unknown;
}

interface DebugHandshake {
	pid: number;
}

const MAX_HANDSHAKE_BYTES = 4096;

export function getDebugSocketPath(agentDir: string, pid: number): string {
	return join(agentDir, "debug", `${pid}.sock`);
}

export class DebugReplServer {
	readonly socketPath: string;
	private readonly agentDir: string;
	private readonly getRuntime: () => DebugRuntime;
	private readonly getStore?: () => unknown;
	private readonly clients = new Set<Socket>();
	private server?: Server;
	private sessionId?: string;

	constructor(options: DebugReplServerOptions) {
		this.agentDir = options.agentDir;
		this.getRuntime = options.getRuntime;
		this.getStore = options.getStore;
		this.socketPath = getDebugSocketPath(options.agentDir, process.pid);
	}

	async enable(sessionId: string): Promise<string> {
		this.sessionId = sessionId;
		if (this.server) return this.socketPath;

		const debugDirectory = join(this.agentDir, "debug");
		mkdirSync(debugDirectory, { mode: 0o700, recursive: true });
		chmodSync(debugDirectory, 0o700);
		if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });

		this.server = createServer((socket) => this.acceptClient(socket));
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(this.socketPath, () => resolve());
		});
		chmodSync(this.socketPath, 0o600);
		return this.socketPath;
	}

	async disable(): Promise<void> {
		for (const client of this.clients) client.destroy();
		this.clients.clear();
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
		this.sessionId = undefined;
	}

	async evaluateForTest(expression: string, clientPid = process.pid): Promise<unknown> {
		const startedAt = Date.now();
		try {
			const result = runInNewContext(expression, { pi: this.createPiRoot() });
			this.writeAudit(clientPid, expression, startedAt, "success");
			return await Promise.resolve(result);
		} catch (error) {
			this.writeAudit(clientPid, expression, startedAt, "error");
			throw error;
		}
	}

	private acceptClient(socket: Socket): void {
		this.clients.add(socket);
		socket.once("close", () => this.clients.delete(socket));
		this.readHandshake(socket)
			.then(({ pid, remaining }) => {
				if (remaining.length > 0) socket.unshift(remaining);
				this.startRepl(socket, pid);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				socket.end(`Debug attachment rejected: ${message}\n`);
			});
	}

	private readHandshake(socket: Socket): Promise<{ pid: number; remaining: Buffer }> {
		return new Promise((resolve, reject) => {
			let buffered = Buffer.alloc(0);
			const onData = (chunk: Buffer) => {
				buffered = Buffer.concat([buffered, chunk]);
				if (buffered.length > MAX_HANDSHAKE_BYTES) {
					cleanup();
					reject(new Error("handshake exceeds size limit"));
					return;
				}
				const newline = buffered.indexOf(0x0a);
				if (newline < 0) return;
				cleanup();
				try {
					const handshake = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as Partial<DebugHandshake>;
					if (!Number.isInteger(handshake.pid) || (handshake.pid ?? 0) <= 0) throw new Error("invalid client PID");
					resolve({ pid: handshake.pid as number, remaining: buffered.subarray(newline + 1) });
				} catch (error) {
					reject(error);
				}
			};
			const onClose = () => {
				cleanup();
				reject(new Error("connection closed before handshake"));
			};
			const cleanup = () => {
				socket.off("data", onData);
				socket.off("close", onClose);
			};
			socket.on("data", onData);
			socket.once("close", onClose);
		});
	}

	private startRepl(socket: Socket, clientPid: number): void {
		const replSession = repl.start({ input: socket, output: socket, prompt: "pi> ", terminal: true });
		Object.defineProperty(replSession.context, "pi", {
			configurable: false,
			enumerable: true,
			value: this.createPiRoot(),
			writable: false,
		});
		this.wrapEvaluator(replSession, clientPid);
	}

	private wrapEvaluator(replSession: repl.REPLServer, clientPid: number): void {
		const evaluate = replSession.eval.bind(replSession);
		const auditEvaluator: repl.REPLEval = (command, context, filename, callback) => {
			const startedAt = Date.now();
			evaluate(command, context, filename, (error, result) => {
				this.writeAudit(clientPid, command, startedAt, error ? "error" : "success");
				callback(error, result);
			});
		};
		Object.defineProperty(replSession, "eval", { value: auditEvaluator });
	}

	private createPiRoot(): object {
		const getRuntime = this.getRuntime;
		const getStore = this.getStore;
		return Object.freeze({
			get agent() {
				const session = getRuntime().session as { agent?: unknown };
				return session.agent;
			},
			get runtime() {
				return getRuntime();
			},
			get services() {
				return getRuntime().services;
			},
			get session() {
				return getRuntime().session;
			},
			get store() {
				return getStore?.();
			},
		});
	}

	private writeAudit(clientPid: number, expression: string, startedAt: number, status: "error" | "success"): void {
		const auditPath = join(this.agentDir, "debug", "audit.jsonl");
		const record = {
			clientPid,
			durationMs: Date.now() - startedAt,
			expressionHash: createHash("sha256").update(expression).digest("hex"),
			sessionId: this.sessionId,
			status,
			timestamp: new Date().toISOString(),
		};
		appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(auditPath, 0o600);
	}
}

let configuredServer: DebugReplServer | undefined;

export function configureDebugRepl(options: DebugReplServerOptions): DebugReplServer {
	configuredServer = new DebugReplServer(options);
	return configuredServer;
}

export function getConfiguredDebugRepl(): DebugReplServer {
	if (!configuredServer) throw new Error("Debug REPL is not available before runtime initialization");
	return configuredServer;
}
