import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { inspect } from "node:util";
import { type Context, createContext, runInContext, Script } from "node:vm";

interface DebugSession {
	readonly agent?: unknown;
	readonly sessionId?: string;
}

interface DebugRuntime {
	readonly session: DebugSession;
	readonly services?: unknown;
}

interface DebugReplServerOptions {
	agentDir: string;
	getRuntime: () => DebugRuntime;
	getStore?: () => unknown;
}

interface DebugHandshake {
	pid: number;
	sessionId: string;
}

const MAX_HANDSHAKE_BYTES = 4096;
const PRIMARY_PROMPT = "pi> ";
const CONTINUATION_PROMPT = "... ";

export function getDebugSocketPath(agentDir: string, pid: number): string {
	return join(agentDir, "debug", `${pid}.sock`);
}

export class DebugReplServer {
	readonly socketPath: string;
	private readonly agentDir: string;
	private readonly getRuntime: () => DebugRuntime;
	private readonly getStore?: () => unknown;
	private readonly clients = new Set<Socket>();
	private readonly removeSocketOnExit = () => this.removeSocketFile();
	private server?: Server;

	constructor(options: DebugReplServerOptions) {
		this.agentDir = options.agentDir;
		this.getRuntime = options.getRuntime;
		this.getStore = options.getStore;
		this.socketPath = getDebugSocketPath(options.agentDir, process.pid);
	}

	async enable(_sessionId: string): Promise<string> {
		if (this.server) return this.socketPath;

		const debugDirectory = join(this.agentDir, "debug");
		mkdirSync(debugDirectory, { mode: 0o700, recursive: true });
		chmodSync(debugDirectory, 0o700);
		this.removeSocketFile();

		const server = createServer((socket) => this.acceptClient(socket));
		try {
			await this.listen(server);
		} catch (error) {
			server.close();
			this.removeSocketFile();
			throw error;
		}
		this.server = server;
		process.once("exit", this.removeSocketOnExit);
		chmodSync(this.socketPath, 0o600);
		return this.socketPath;
	}

	async disable(): Promise<void> {
		process.off("exit", this.removeSocketOnExit);
		for (const client of this.clients) client.destroy();
		this.clients.clear();
		const server = this.server;
		this.server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		this.removeSocketFile();
	}

	async evaluateForTest(expression: string, clientPid = process.pid): Promise<unknown> {
		return this.evaluateAndAudit(expression, clientPid, this.createEvaluationContext());
	}

	private listen(server: Server): Promise<void> {
		return new Promise((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.socketPath);
		});
	}

	private acceptClient(socket: Socket): void {
		this.clients.add(socket);
		socket.once("close", () => this.clients.delete(socket));
		this.readHandshake(socket)
			.then(({ handshake, remaining }) => {
				if (handshake.sessionId !== this.currentSessionId()) {
					throw new Error(`session mismatch: expected ${handshake.sessionId}, current ${this.currentSessionId()}`);
				}
				if (remaining.length > 0) socket.unshift(remaining);
				this.startRepl(socket, handshake.pid);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				socket.end(`Debug attachment rejected: ${message}\n`);
			});
	}

	private readHandshake(socket: Socket): Promise<{ handshake: DebugHandshake; remaining: Buffer }> {
		return new Promise((resolve, reject) => {
			let buffered = Buffer.alloc(0);
			const cleanup = () => {
				socket.off("data", onData);
				socket.off("close", onClose);
			};
			const onClose = () => {
				cleanup();
				reject(new Error("connection closed before handshake"));
			};
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
					if (!handshake.sessionId?.trim()) throw new Error("missing session ID");
					resolve({
						handshake: { pid: handshake.pid as number, sessionId: handshake.sessionId },
						remaining: buffered.subarray(newline + 1),
					});
				} catch (error) {
					reject(error);
				}
			};
			socket.on("data", onData);
			socket.once("close", onClose);
		});
	}

	private startRepl(socket: Socket, clientPid: number): void {
		const context = this.createEvaluationContext();
		let input = "";
		let source = "";
		let evaluations = Promise.resolve();
		socket.on("data", (chunk: Buffer) => {
			input += chunk.toString("utf8");
			while (true) {
				const newline = input.indexOf("\n");
				if (newline < 0) return;
				const line = input.slice(0, newline).replace(/\r$/, "");
				input = input.slice(newline + 1);
				if (line.trim() === ".exit") {
					socket.end();
					return;
				}
				source = source ? `${source}\n${line}` : line;
				if (this.isIncomplete(source)) {
					socket.write(CONTINUATION_PROMPT);
					continue;
				}
				const expression = source;
				source = "";
				evaluations = evaluations.then(() => this.evaluateLine(socket, expression, clientPid, context));
			}
		});
		socket.write(PRIMARY_PROMPT);
	}

	private async evaluateLine(socket: Socket, expression: string, clientPid: number, context: Context): Promise<void> {
		try {
			const result = await this.evaluateAndAudit(expression, clientPid, context);
			socket.write(`${inspect(result, { colors: true, depth: 8 })}\n`);
		} catch (error) {
			socket.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		}
		socket.write(PRIMARY_PROMPT);
	}

	private async evaluateAndAudit(expression: string, clientPid: number, context: Context): Promise<unknown> {
		const startedAt = Date.now();
		try {
			const result = this.runExpression(expression, context);
			const settled = await Promise.resolve(result);
			this.writeAudit(clientPid, expression, startedAt, "success");
			return settled;
		} catch (error) {
			this.writeAudit(clientPid, expression, startedAt, "error");
			throw error;
		}
	}

	private runExpression(expression: string, context: Context): unknown {
		try {
			return runInContext(expression, context);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const isTopLevelAwait = /await is only valid|unexpected reserved word/i.test(message);
			if (!isTopLevelAwait) throw error;
			return runInContext(`(async () => (${expression}))()`, context);
		}
	}

	private isIncomplete(source: string): boolean {
		try {
			new Script(source);
			return false;
		} catch (error) {
			if (!(error instanceof SyntaxError)) return false;
			return /unexpected end|unterminated|missing[ )}\]]*$/i.test(error.message);
		}
	}

	private createEvaluationContext(): Context {
		return createContext({
			Buffer,
			clearInterval,
			clearTimeout,
			console,
			fetch,
			pi: this.createPiRoot(),
			process,
			setInterval,
			setTimeout,
		});
	}

	private createPiRoot(): object {
		const getRuntime = this.getRuntime;
		const getStore = this.getStore;
		return Object.freeze({
			get agent() {
				return getRuntime().session.agent;
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

	private currentSessionId(): string {
		return this.getRuntime().session.sessionId ?? "unknown";
	}

	private writeAudit(clientPid: number, expression: string, startedAt: number, status: "error" | "success"): void {
		const auditPath = join(this.agentDir, "debug", "audit.jsonl");
		const record = {
			claimedClientPid: clientPid,
			durationMs: Date.now() - startedAt,
			expressionHash: createHash("sha256").update(expression).digest("hex"),
			sessionId: this.currentSessionId(),
			status,
			timestamp: new Date().toISOString(),
		};
		appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(auditPath, 0o600);
	}

	private removeSocketFile(): void {
		if (existsSync(this.socketPath)) rmSync(this.socketPath, { force: true });
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
