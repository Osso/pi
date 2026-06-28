import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { EOL, homedir } from "node:os";

export interface CanonicalHostrunEvalParams {
	code: string;
	pi?: unknown;
	pi_bridge?: boolean;
	session_id?: string;
}

export interface CanonicalHostrunConsoleEntry {
	level: string;
	message: string;
}

export interface CanonicalHostrunApprovalRequest {
	args: unknown;
	id: string;
	summary: string;
	tool: string;
}

export interface CanonicalHostrunEvalResult {
	approval?: CanonicalHostrunApprovalRequest;
	console?: CanonicalHostrunConsoleEntry[];
	error?: string;
	executed?: string;
	type: "completed" | "needs_approval";
	value?: unknown;
}

export interface CanonicalHostrunProgressUpdate {
	method?: string;
	message?: string;
	output?: string;
	params?: unknown;
	status?: string;
	text?: string;
	type: string;
	value?: unknown;
}

export type CanonicalHostrunRunnerMessage = CanonicalHostrunEvalResult | CanonicalHostrunProgressUpdate;
export type HostrunPiRequestHandler = (request: { method: string; params: unknown }) => Promise<unknown>;

interface PendingRequest {
	cleanup?: () => void;
	onPiRequest?: HostrunPiRequestHandler;
	onProgress?: (update: CanonicalHostrunProgressUpdate) => void;
	reject: (error: Error) => void;
	resolve: (result: CanonicalHostrunEvalResult) => void;
}

export interface HostrunRunnerOptions {
	args?: string[];
	command?: string;
}

export interface HostrunRunnerResolutionOptions {
	env?: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
	homeDir?: string;
}

function parseRunnerArgs(value: string | undefined): string[] | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
		throw new Error("PI_HOSTRUN_RUNNER_ARGS must be a JSON string array");
	}
	return parsed;
}

export function resolveHostrunRunnerOptions(
	resolution: HostrunRunnerResolutionOptions = {},
): Required<HostrunRunnerOptions> {
	const env = resolution.env ?? process.env;
	const exists = resolution.exists ?? existsSync;
	const homeDir = resolution.homeDir ?? homedir();
	const localHostrunRunner = "/home/osso/Repos/hostrun/target/debug/hostrun-jsonl";
	const cargoHostrunRunner = `${homeDir}/.cargo/bin/hostrun-jsonl`;
	const command = env.PI_HOSTRUN_RUNNER_COMMAND ?? env.PI_HOSTRUN_RUNNER;
	if (command) {
		return {
			args: parseRunnerArgs(env.PI_HOSTRUN_RUNNER_ARGS) ?? ["--serve"],
			command,
		};
	}
	if (exists(localHostrunRunner)) {
		return {
			args: parseRunnerArgs(env.PI_HOSTRUN_RUNNER_ARGS) ?? [],
			command: localHostrunRunner,
		};
	}
	if (exists(cargoHostrunRunner)) {
		return {
			args: parseRunnerArgs(env.PI_HOSTRUN_RUNNER_ARGS) ?? ["--serve"],
			command: cargoHostrunRunner,
		};
	}
	return {
		args: parseRunnerArgs(env.PI_HOSTRUN_RUNNER_ARGS) ?? ["--serve"],
		command: "hostrun-jsonl",
	};
}

export class HostrunRunnerClient {
	private buffer = "";
	private readonly options: HostrunRunnerOptions;
	private process: ChildProcessWithoutNullStreams | undefined;
	private readonly pending: PendingRequest[] = [];
	private readonly stderr: string[] = [];

	constructor(options: HostrunRunnerOptions = {}) {
		this.options = options;
	}

	evaluate(
		params: CanonicalHostrunEvalParams,
		onProgress?: (update: CanonicalHostrunProgressUpdate) => void,
		signal?: AbortSignal,
		onPiRequest?: HostrunPiRequestHandler,
	): Promise<CanonicalHostrunEvalResult> {
		if (signal?.aborted) {
			return Promise.reject(new Error("Hostrun evaluation aborted"));
		}
		const child = this.ensureProcess();
		const payload = JSON.stringify(params);
		return new Promise((resolve, reject) => {
			const pending: PendingRequest = { onPiRequest, onProgress, reject, resolve };
			if (signal) {
				const onAbort = () => {
					this.process?.kill();
					this.process = undefined;
					this.rejectAll(new Error("Hostrun evaluation aborted"));
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
		const options = { ...resolveHostrunRunnerOptions(), ...this.options };
		const child = spawn(options.command, options.args, { stdio: ["pipe", "pipe", "pipe"] });
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
			this.rejectAll(new Error(`Hostrun runner exited with ${reason}${stderr ? `${EOL}${stderr}` : ""}`));
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
			const message = JSON.parse(line) as CanonicalHostrunRunnerMessage;
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

	private async respondToPiRequest(message: CanonicalHostrunProgressUpdate, pending: PendingRequest): Promise<void> {
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

function isFinalEvalResult(message: CanonicalHostrunRunnerMessage): message is CanonicalHostrunEvalResult {
	return message.type === "completed" || message.type === "needs_approval";
}

function isPiRequest(message: CanonicalHostrunRunnerMessage): message is CanonicalHostrunProgressUpdate {
	return message.type === "pi_request";
}
