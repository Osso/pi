import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { EOL } from "node:os";
import { join } from "node:path";

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

interface PendingRequest {
	cleanup?: () => void;
	onPiRequest?: PyrunPiRequestHandler;
	onProgress?: (update: CanonicalPyrunProgressUpdate) => void;
	reject: (error: Error) => void;
	resolve: (result: CanonicalPyrunEvalResult) => void;
}

export interface PyrunRunnerOptions {
	args?: string[];
	command?: string;
	env?: NodeJS.ProcessEnv;
	inheritEnv?: boolean;
}

export interface PyrunRunnerResolutionOptions {
	env?: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
}

type ResolvedPyrunRunnerOptions = Required<Omit<PyrunRunnerOptions, "inheritEnv">>;

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

const localPyrunCheckout = "/syncthing/Sync/Projects/claude/pyrun";
const localPyrunPackagePaths = [join(localPyrunCheckout, "pyrun", "jsonl.py"), join(localPyrunCheckout, "src", "pyrun", "jsonl.py")];

function hasLocalPyrunCheckout(exists: (path: string) => boolean): boolean {
	return localPyrunPackagePaths.some((path) => exists(path));
}

export function resolvePyrunRunnerOptions(resolution: PyrunRunnerResolutionOptions = {}): ResolvedPyrunRunnerOptions {
	const env = resolution.env ?? process.env;
	const args = parseRunnerArgs(env.PI_PYRUN_RUNNER_ARGS);
	const commandOverride = env.PI_PYRUN_RUNNER_COMMAND ?? env.PI_PYRUN_RUNNER;
	if (commandOverride) {
		return { args: args ?? [], command: commandOverride, env: {} };
	}
	if (hasLocalPyrunCheckout(resolution.exists ?? existsSync)) {
		return {
			args: args ?? ["-m", "pyrun.jsonl"],
			command: "python3",
			env: { PYTHONPATH: localPyrunCheckout },
		};
	}
	return { args: args ?? [], command: "pyrun-jsonl", env: {} };
}

export class PyrunRunnerClient {
	private buffer = "";
	private readonly options: PyrunRunnerOptions;
	private process: ChildProcessWithoutNullStreams | undefined;
	private readonly pending: PendingRequest[] = [];
	private readonly stderr: string[] = [];

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
		const child = this.ensureProcess();
		const payload = JSON.stringify(params);
		return new Promise((resolve, reject) => {
			const pending: PendingRequest = { onPiRequest, onProgress, reject, resolve };
			if (signal) {
				const onAbort = () => {
					this.process?.kill();
					this.process = undefined;
					this.rejectAll(new Error("Pyrun evaluation aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				pending.cleanup = () => signal.removeEventListener("abort", onAbort);
			}
			this.pending.push(pending);
			child.stdin.write(`${payload}\n`, (error) => {
				if (error) {
					this.rejectNext(error);
				}
			});
		});
	}

	dispose(): void {
		this.process?.kill();
		this.process = undefined;
	}

	private ensureProcess(): ChildProcessWithoutNullStreams {
		if (this.process) {
			return this.process;
		}
		const resolvedOptions = resolvePyrunRunnerOptions();
		const options = {
			...resolvedOptions,
			...this.options,
			env: { ...resolvedOptions.env, ...this.options.env },
		};
		const child = spawn(options.command, options.args, {
			env: options.inheritEnv === false ? options.env : { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
		child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
		child.on("error", (error) => this.rejectAll(error));
		child.on("exit", (code, signal) => {
			this.process = undefined;
			if (this.pending.length === 0) {
				return;
			}
			const stderr = this.stderr.join("").trim();
			const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
			this.rejectAll(new Error(`Pyrun runner exited with ${reason}${stderr ? `${EOL}${stderr}` : ""}`));
		});
		return child;
	}

	private handleStdout(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim().length === 0) {
				continue;
			}
			this.resolveNext(line);
		}
	}

	private resolveNext(line: string): void {
		const pending = this.pending[0];
		if (!pending) {
			return;
		}
		try {
			const message = JSON.parse(line) as CanonicalPyrunRunnerMessage;
			if (isFinalEvalResult(message)) {
				this.pending.shift();
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
			this.pending.shift();
			pending.cleanup?.();
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private async respondToPiRequest(message: CanonicalPyrunProgressUpdate, pending: PendingRequest): Promise<void> {
		const child = this.process;
		const method = typeof message.method === "string" ? message.method : "";
		try {
			const result = await pending.onPiRequest?.({ method, params: message.params });
			child?.stdin.write(`${JSON.stringify({ result })}\n`);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			child?.stdin.write(`${JSON.stringify({ error: text })}\n`);
		}
	}

	private rejectNext(error: Error): void {
		const pending = this.pending.shift();
		if (pending) {
			pending.cleanup?.();
			pending.reject(error);
		}
	}

	private rejectAll(error: Error): void {
		while (this.pending.length > 0) {
			this.rejectNext(error);
		}
	}
}

function isFinalEvalResult(message: CanonicalPyrunRunnerMessage): message is CanonicalPyrunEvalResult {
	return message.type === "completed" || message.type === "error" || message.type === "needs_approval";
}

function isPiRequest(message: CanonicalPyrunRunnerMessage): message is CanonicalPyrunProgressUpdate {
	return message.type === "pi_request";
}
