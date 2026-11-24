import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../../../src/config.ts";
import {
	isProcessIdentityAlive,
	type ProcessIdentity,
	readProcessIdentity,
} from "../../../src/core/runtime-process.ts";
import {
	type CanonicalPyrunEvalParams,
	type CanonicalPyrunEvalResult,
	type CanonicalPyrunProgressUpdate,
	isFinalEvalResult,
	isPiRequest,
	type PyrunPiRequestHandler,
	PyrunRunnerClient,
	type PyrunRunnerOptions,
} from "./runner.ts";

/**
 * A `pyrun_eval` with a `session_id` runs in that named session's long-lived Python, so `ctx` persists
 * across calls and Pi restarts. Names are scoped to the Pi session and shared by its agents. One proxy per
 * Pi session (and sandbox) hosts every named Python, so a name costs one Python, not another proxy process.
 * Each durable evaluation runner sends its request to the proxy over a Unix socket in the pyrun-jsonl line
 * protocol. A call to a session that is still running an evaluation fails at once instead of waiting.
 * A named Python stops once it has been idle for an hour, or as soon as it is idle after its owner Pi process
 * is gone; the proxy exits when it has no Python and no connection. A restart keeps the Pi process ID, so
 * without the idle limit every named session an agent ever used would keep its Python for the life of the
 * session.
 */
export const PYRUN_SESSION_PROXY_MODE = "--internal-pyrun-session-proxy";
const OWNER_POLL_MS = 2_000;
const DEFAULT_IDLE_EXIT_MS = 60 * 60 * 1000;
const START_POLL_MS = 20;
const START_TIMEOUT_MS = 30_000;

interface PyrunSessionProxyConfig {
	owner: ProcessIdentity;
	runnerOptions: PyrunRunnerOptions;
	socketPath: string;
}

export interface PyrunSessionProxyTarget {
	/** Starts each named Python; the request supplies its cwd. */
	runnerOptions: PyrunRunnerOptions;
	sessionPath: string;
}

function pyrunSessionSocketPath(target: PyrunSessionProxyTarget): string {
	const uid = process.getuid?.() ?? 0;
	const directory = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pi-pyrun-${uid}`);
	mkdirSync(directory, { mode: 0o700, recursive: true });
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
		throw new Error(`Pyrun socket directory must be a private directory owned by this user: ${directory}`);
	}
	// The environment stays out of the key: it can change across a restart without changing the runner.
	const { command, args } = target.runnerOptions;
	const key = JSON.stringify([target.sessionPath, command, args]);
	return join(directory, `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.sock`);
}

function canConnect(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

const proxyStarts = new Map<string, Promise<void>>();

/** Returns the socket of the session's Pyrun proxy, starting the proxy when none is listening. */
export async function ensurePyrunSessionProxy(target: PyrunSessionProxyTarget): Promise<string> {
	const socketPath = pyrunSessionSocketPath(target);
	if (await canConnect(socketPath)) return socketPath;
	let start = proxyStarts.get(socketPath);
	if (!start) {
		start = startPyrunSessionProxy(socketPath, target).finally(() => proxyStarts.delete(socketPath));
		proxyStarts.set(socketPath, start);
	}
	await start;
	return socketPath;
}

function pyrunSessionProxyInvocation(): { args: string[]; executable: string } {
	if (isBunBinary) return { args: [PYRUN_SESSION_PROXY_MODE], executable: process.execPath };
	const extension = extname(fileURLToPath(import.meta.url));
	const entryPath = fileURLToPath(new URL(`./session-proxy-entry${extension}`, import.meta.url));
	const args = extension === ".ts" ? ["--experimental-strip-types", entryPath] : [entryPath];
	return { args, executable: process.execPath };
}

async function startPyrunSessionProxy(socketPath: string, target: PyrunSessionProxyTarget): Promise<void> {
	const logPath = socketPath.replace(/\.sock$/, ".log");
	const log = openSync(logPath, "w", 0o600);
	const { args, executable } = pyrunSessionProxyInvocation();
	const child = spawn(executable, args, {
		cwd: dirname(target.sessionPath),
		detached: true,
		env: process.env,
		stdio: ["pipe", log, log],
	});
	closeSync(log);
	child.once("error", () => undefined);
	// The config travels over stdin: the runner environment must not be written to disk.
	const config: PyrunSessionProxyConfig = {
		owner: readProcessIdentity(process.pid),
		runnerOptions: target.runnerOptions,
		socketPath,
	};
	child.stdin?.end(JSON.stringify(config));
	child.unref();
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (!(await canConnect(socketPath))) {
		if (child.exitCode !== null || Date.now() >= deadline) {
			const diagnostic = readFileSync(logPath, "utf8").trim();
			throw new Error(`Pyrun session proxy did not start${diagnostic ? `: ${diagnostic}` : ""}`);
		}
		await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

export async function runPyrunSessionProxy(): Promise<void> {
	const config = JSON.parse(await readStdin()) as PyrunSessionProxyConfig;
	let owner = config.owner;
	const idleExitMs = Number(process.env.PI_PYRUN_SESSION_IDLE_MS) || DEFAULT_IDLE_EXIT_MS;
	let connections = 0;
	const pythons = new Map<string, PyrunSessionPython>();
	const server = createServer((socket) => {
		connections += 1;
		socket.once("close", () => {
			connections -= 1;
		});
		servePyrunConnection(pythons, config.runnerOptions, socket, (next) => {
			owner = next;
		}).catch(() => socket.destroy());
	});
	rmSync(config.socketPath, { force: true });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.socketPath, resolve);
	});
	await new Promise<void>((resolve) => {
		const timer = setInterval(() => {
			stopIdlePythons(pythons, isProcessIdentityAlive(owner) ? idleExitMs : 0);
			if (connections > 0 || pythons.size > 0) return;
			clearInterval(timer);
			resolve();
		}, OWNER_POLL_MS);
	});
	server.close();
	rmSync(config.socketPath, { force: true });
	rmSync(config.socketPath.replace(/\.sock$/, ".log"), { force: true });
}

interface PyrunSessionPython {
	busy: boolean;
	client: PyrunRunnerClient;
	idleSince: number;
}

function stopIdlePythons(pythons: Map<string, PyrunSessionPython>, idleExitMs: number): void {
	const now = Date.now();
	for (const [key, python] of pythons) {
		if (python.busy || now - python.idleSince < idleExitMs) continue;
		python.client.dispose();
		pythons.delete(key);
	}
}

type JsonLines = AsyncIterator<string>;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function writeJsonLine(socket: Socket, message: unknown): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function readJsonLines(socket: Socket): JsonLines {
	return createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: socket })[Symbol.asyncIterator]();
}

/** Forwards Python's Pi requests to the evaluation runner and returns the runner's reply. */
function relayPiRequests(socket: Socket, lines: JsonLines): PyrunPiRequestHandler {
	return async (piRequest) => {
		writeJsonLine(socket, { ...piRequest, type: "pi_request" });
		const reply = await lines.next();
		if (reply.done) throw new Error("Pyrun session connection closed");
		const parsed = JSON.parse(reply.value) as { error?: string; result?: unknown };
		if (parsed.error !== undefined) throw new Error(parsed.error);
		return parsed.result;
	};
}

async function servePyrunConnection(
	pythons: Map<string, PyrunSessionPython>,
	runnerOptions: PyrunRunnerOptions,
	socket: Socket,
	setOwner: (owner: ProcessIdentity) => void,
): Promise<void> {
	// A connection that closes before its result arrives cancels the evaluation, which stops Python.
	const abort = new AbortController();
	socket.once("close", () => abort.abort());
	socket.on("error", () => abort.abort());
	const lines = readJsonLines(socket);
	const first = await lines.next();
	if (first.done) return;
	const request = JSON.parse(first.value) as {
		cwd: string;
		owner: ProcessIdentity;
		params: CanonicalPyrunEvalParams;
	};
	// A Pi process that resumed the session after its previous process exited takes over ownership.
	setOwner(request.owner);
	// A named session has one Python per cwd: relative paths in evaluations resolve against that cwd.
	const key = JSON.stringify([request.params.session_id, request.cwd]);
	let python = pythons.get(key);
	if (!python) {
		python = {
			busy: false,
			client: new PyrunRunnerClient({ ...runnerOptions, cwd: request.cwd }),
			idleSince: Date.now(),
		};
		pythons.set(key, python);
	}
	const reply = await evaluateInSession(python, request.params, socket, lines, abort.signal);
	writeJsonLine(socket, reply);
	socket.end();
}

async function evaluateInSession(
	session: PyrunSessionPython,
	params: CanonicalPyrunEvalParams,
	socket: Socket,
	lines: JsonLines,
	signal: AbortSignal,
): Promise<unknown> {
	if (session.busy) {
		// Agents that got only the first half of this advice killed the runner process by hand, which
		// loses the evaluation's result; point them at the supported ways to wait or stop.
		const error = `Pyrun session ${params.session_id} is busy with another evaluation. Wait for it to finish (wait_agent if it moved to the background), cancel its background job with close_agent, or use another session_id. Do not kill the runner process.`;
		return { error, type: "proxy_error" };
	}
	session.busy = true;
	try {
		const sendProgress = (update: unknown) => writeJsonLine(socket, update);
		return await session.client.evaluate(params, sendProgress, signal, relayPiRequests(socket, lines));
	} catch (error) {
		return { error: errorMessage(error), type: "proxy_error" };
	} finally {
		session.busy = false;
		session.idleSince = Date.now();
	}
}

interface ProxyReplyHandlers {
	fail: (error: Error) => void;
	onPiRequest?: PyrunPiRequestHandler;
	onProgress?: (update: CanonicalPyrunProgressUpdate) => void;
	resolve: (result: CanonicalPyrunEvalResult) => void;
	socket: Socket;
}

function answerPiRequest(message: CanonicalPyrunProgressUpdate, handlers: ProxyReplyHandlers): void {
	const method = typeof message.method === "string" ? message.method : "";
	Promise.resolve(handlers.onPiRequest?.({ method, params: message.params })).then(
		(result) => writeJsonLine(handlers.socket, { result }),
		(error: unknown) => writeJsonLine(handlers.socket, { error: errorMessage(error) }),
	);
}

function handleProxyReply(line: string, handlers: ProxyReplyHandlers): void {
	const message = JSON.parse(line) as CanonicalPyrunEvalResult | CanonicalPyrunProgressUpdate;
	if (message.type === "proxy_error") {
		handlers.fail(new Error(String((message as { error?: unknown }).error)));
	} else if (isFinalEvalResult(message)) {
		handlers.resolve(message);
	} else if (isPiRequest(message)) {
		answerPiRequest(message, handlers);
	} else {
		handlers.onProgress?.(message);
	}
}

/** Evaluates through the session proxy with the same contract as `PyrunRunnerClient.evaluate`. */
export class PyrunSessionClient {
	private readonly cwd: string;
	private readonly owner: ProcessIdentity;
	private socket: Socket | undefined;
	private readonly socketPath: string;

	constructor(socketPath: string, owner: ProcessIdentity, cwd: string) {
		this.cwd = cwd;
		this.owner = owner;
		this.socketPath = socketPath;
	}

	evaluate(
		params: CanonicalPyrunEvalParams,
		onProgress?: (update: CanonicalPyrunProgressUpdate) => void,
		signal?: AbortSignal,
		onPiRequest?: PyrunPiRequestHandler,
	): Promise<CanonicalPyrunEvalResult> {
		if (signal?.aborted) return Promise.reject(new Error("Pyrun evaluation aborted"));
		const socket = connect(this.socketPath);
		this.socket = socket;
		return new Promise((resolve, reject) => {
			const fail = (error: Error) => {
				socket.destroy();
				reject(error);
			};
			signal?.addEventListener("abort", () => fail(new Error("Pyrun evaluation aborted")), { once: true });
			socket.once("error", fail);
			socket.once("close", () => reject(new Error("Pyrun session proxy closed the connection")));
			const handlers: ProxyReplyHandlers = { fail, onPiRequest, onProgress, resolve, socket };
			createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: socket }).on("line", (line) => {
				try {
					handleProxyReply(line, handlers);
				} catch (error) {
					fail(new Error(errorMessage(error)));
				}
			});
			writeJsonLine(socket, { cwd: this.cwd, owner: this.owner, params });
		});
	}

	dispose(): void {
		this.socket?.destroy();
	}
}
