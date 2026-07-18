import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EOL } from "node:os";

export interface CanonicalPyrunEvalParams {
	code: string;
	pi?: unknown;
	pi_bridge?: boolean;
	session_id?: string;
	stream_console?: boolean;
}

export type CanonicalPyrunConsoleEntry = string | { level: string; message: string };

export interface CanonicalPyrunApprovalRequest {
	args: unknown;
	id: string;
	summary: string;
	tool: string;
}

export interface CanonicalPyrunEvalResult {
	approval?: CanonicalPyrunApprovalRequest;
	console?: CanonicalPyrunConsoleEntry[];
	error?: string;
	executed?: string;
	type: "completed" | "error" | "needs_approval";
	value?: unknown;
}

export interface CanonicalPyrunProgressUpdate {
	message?: string;
	method?: string;
	output?: string;
	params?: unknown;
	status?: string;
	stream?: string;
	text?: string;
	type: string;
	value?: unknown;
}

export type CanonicalPyrunRunnerMessage = CanonicalPyrunEvalResult | CanonicalPyrunProgressUpdate;
export type PyrunPiRequestHandler = (request: { method: string; params: unknown }) => Promise<unknown>;

interface RunnerGeneration {
	buffer: string;
	child: ChildProcessWithoutNullStreams;
	generation: number;
	stderr: string[];
}

interface PendingRequest {
	cleanup?: () => void;
	generation: RunnerGeneration;
	onPiRequest?: PyrunPiRequestHandler;
	onProgress?: (update: CanonicalPyrunProgressUpdate) => void;
	reject: (error: Error) => void;
	resolve: (result: CanonicalPyrunEvalResult) => void;
}

export interface PyrunRunnerOptions {
	args?: string[];
	command?: string;
	detached?: boolean;
	env?: NodeJS.ProcessEnv;
	inheritEnv?: boolean;
}

export interface PyrunRunnerResolutionOptions {
	env?: NodeJS.ProcessEnv;
}

type ResolvedPyrunRunnerOptions = Required<Omit<PyrunRunnerOptions, "detached" | "inheritEnv">>;

function parseRunnerArgs(value: string | undefined): string[] | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
		throw new Error("PI_PYRUN_RUNNER_ARGS must be a JSON string array");
	}
	return parsed;
}

export function resolvePyrunRunnerOptions(resolution: PyrunRunnerResolutionOptions = {}): ResolvedPyrunRunnerOptions {
	const env = resolution.env ?? process.env;
	const args = parseRunnerArgs(env.PI_PYRUN_RUNNER_ARGS);
	const commandOverride = env.PI_PYRUN_RUNNER_COMMAND ?? env.PI_PYRUN_RUNNER;
	if (commandOverride) {
		return { args: args ?? [], command: commandOverride, env: {} };
	}
	return { args: args ?? [], command: "pyrun-jsonl", env: {} };
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

function terminateRunnerTree(
	child: ChildProcessWithoutNullStreams,
	detached: boolean,
	signal: NodeJS.Signals = "SIGTERM",
): void {
	if (process.platform === "win32" && child.pid !== undefined) {
		const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		if (result.status === 0) return;
	}
	const canSignalProcessGroup = detached && process.platform !== "win32" && child.pid !== undefined;
	if (canSignalProcessGroup && signalProcessGroup(child.pid, signal)) return;
	child.kill(signal);
}

export class PyrunRunnerClient {
	private nextGeneration = 0;
	private readonly options: PyrunRunnerOptions;
	private process: RunnerGeneration | undefined;
	private readonly pending: PendingRequest[] = [];

	constructor(options: PyrunRunnerOptions = {}) {
		this.options = options;
	}

	evaluate(
		params: CanonicalPyrunEvalParams,
		onProgress?: (update: CanonicalPyrunProgressUpdate) => void,
		signal?: AbortSignal,
		onPiRequest?: PyrunPiRequestHandler,
	): Promise<CanonicalPyrunEvalResult> {
		if (signal?.aborted) {
			return Promise.reject(new Error("Pyrun evaluation aborted"));
		}
		const generation = this.ensureProcess();
		const payload = JSON.stringify(params);
		return new Promise((resolve, reject) => {
			const pending: PendingRequest = { generation, onPiRequest, onProgress, reject, resolve };
			if (signal) {
				const onAbort = () => {
					this.terminateGeneration(generation);
					this.rejectPending(pending, new Error("Pyrun evaluation aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				pending.cleanup = () => signal.removeEventListener("abort", onAbort);
			}
			this.pending.push(pending);
			generation.child.stdin.write(`${payload}\n`, (error) => {
				if (error) {
					this.rejectPending(pending, error);
				}
			});
		});
	}

	dispose(): void {
		this.terminateProcess();
	}

	private terminateProcess(): void {
		const generation = this.process;
		if (generation) this.terminateGeneration(generation);
	}

	private terminateGeneration(generation: RunnerGeneration): void {
		if (this.process === generation) {
			this.process = undefined;
		}
		terminateRunnerTree(generation.child, this.shouldDetachProcess());
	}

	private shouldDetachProcess(): boolean {
		return this.options.detached ?? process.platform !== "win32";
	}

	private ensureProcess(): RunnerGeneration {
		if (this.process) {
			return this.process;
		}
		const resolvedOptions = resolvePyrunRunnerOptions();
		const options = {
			...resolvedOptions,
			...this.options,
			env: { ...resolvedOptions.env, ...this.options.env },
		};
		const detached = this.shouldDetachProcess();
		const child = spawn(options.command, options.args, {
			detached,
			env: options.inheritEnv === false ? options.env : { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const generation: RunnerGeneration = {
			buffer: "",
			child,
			generation: ++this.nextGeneration,
			stderr: [],
		};
		this.process = generation;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(generation, chunk));
		child.stderr.on("data", (chunk: string) => generation.stderr.push(chunk));
		child.on("error", (error) => this.rejectGeneration(generation, error));
		child.on("exit", (code, signal) => {
			if (detached && process.platform !== "win32" && child.pid !== undefined) {
				signalProcessGroup(child.pid, "SIGTERM");
			}
			if (this.process === generation) {
				this.process = undefined;
			}
			if (!this.hasPendingGeneration(generation)) {
				return;
			}
			const stderr = generation.stderr.join("").trim();
			const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
			this.rejectGeneration(generation, new Error(`Pyrun runner exited with ${reason}${stderr ? `${EOL}${stderr}` : ""}`));
		});
		return generation;
	}

	private handleStdout(generation: RunnerGeneration, chunk: string): void {
		generation.buffer += chunk;
		const lines = generation.buffer.split("\n");
		generation.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim().length === 0) {
				continue;
			}
			this.resolveNext(generation, line);
		}
	}

	private resolveNext(generation: RunnerGeneration, line: string): void {
		const pendingIndex = this.pending.findIndex((request) => request.generation === generation);
		const pending = pendingIndex === -1 ? undefined : this.pending[pendingIndex];
		if (!pending) {
			return;
		}
		try {
			const message = JSON.parse(line) as CanonicalPyrunRunnerMessage;
			if (isFinalEvalResult(message)) {
				this.pending.splice(pendingIndex, 1);
				pending.cleanup?.();
				pending.resolve(message);
				return;
			}
			if (isPiRequest(message)) {
				void this.respondToPiRequest(message, pending);
				return;
			}
			pending.onProgress?.(message);
		} catch (error) {
			this.pending.splice(pendingIndex, 1);
			pending.cleanup?.();
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private async respondToPiRequest(message: CanonicalPyrunProgressUpdate, pending: PendingRequest): Promise<void> {
		const child = pending.generation.child;
		const method = typeof message.method === "string" ? message.method : "";
		try {
			const result = await pending.onPiRequest?.({ method, params: message.params });
			child.stdin.write(`${JSON.stringify({ result })}\n`);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			child.stdin.write(`${JSON.stringify({ error: text })}\n`);
		}
	}

	private hasPendingGeneration(generation: RunnerGeneration): boolean {
		return this.pending.some((request) => request.generation === generation);
	}

	private rejectPending(pending: PendingRequest, error: Error): void {
		const index = this.pending.indexOf(pending);
		if (index === -1) return;
		this.pending.splice(index, 1);
		pending.cleanup?.();
		pending.reject(error);
	}

	private rejectGeneration(generation: RunnerGeneration, error: Error): void {
		for (let index = this.pending.length - 1; index >= 0; index -= 1) {
			const pending = this.pending[index];
			if (pending?.generation !== generation) continue;
			this.pending.splice(index, 1);
			pending.cleanup?.();
			pending.reject(error);
		}
	}
}

function isFinalEvalResult(message: CanonicalPyrunRunnerMessage): message is CanonicalPyrunEvalResult {
	return message.type === "completed" || message.type === "error" || message.type === "needs_approval";
}

function isPiRequest(message: CanonicalPyrunRunnerMessage): message is CanonicalPyrunProgressUpdate {
	return message.type === "pi_request";
}
