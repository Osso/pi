import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { EOL } from "node:os";

export interface CanonicalHostrunEvalParams {
	code: string;
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
	message?: string;
	output?: string;
	status?: string;
	text?: string;
	type: string;
	value?: unknown;
}

export type CanonicalHostrunRunnerMessage = CanonicalHostrunEvalResult | CanonicalHostrunProgressUpdate;

interface PendingRequest {
	onProgress?: (update: CanonicalHostrunProgressUpdate) => void;
	reject: (error: Error) => void;
	resolve: (result: CanonicalHostrunEvalResult) => void;
}

export interface HostrunRunnerOptions {
	args?: string[];
	command?: string;
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

function defaultRunnerOptions(): Required<HostrunRunnerOptions> {
	const localHostrunRunner = "/home/osso/Repos/hostrun/target/debug/hostrun-jsonl";
	const command = process.env.PI_HOSTRUN_RUNNER_COMMAND ?? process.env.PI_HOSTRUN_RUNNER;
	if (command) {
		return {
			args: parseRunnerArgs(process.env.PI_HOSTRUN_RUNNER_ARGS) ?? ["--serve"],
			command,
		};
	}
	if (existsSync(localHostrunRunner)) {
		return {
			args: parseRunnerArgs(process.env.PI_HOSTRUN_RUNNER_ARGS) ?? [],
			command: localHostrunRunner,
		};
	}
	return {
		args: parseRunnerArgs(process.env.PI_HOSTRUN_RUNNER_ARGS) ?? ["--serve"],
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
	): Promise<CanonicalHostrunEvalResult> {
		const child = this.ensureProcess();
		const payload = JSON.stringify(params);
		return new Promise((resolve, reject) => {
			this.pending.push({ onProgress, reject, resolve });
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
		const options = { ...defaultRunnerOptions(), ...this.options };
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
				pending.resolve(message);
				return;
			}
			pending.onProgress?.(message);
		} catch (error) {
			this.pending.shift();
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private rejectNext(error: Error): void {
		const pending = this.pending.shift();
		if (pending) {
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
