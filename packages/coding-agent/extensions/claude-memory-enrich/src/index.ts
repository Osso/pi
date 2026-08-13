import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const DEFAULT_CLAUDE_MEMORY = "/home/osso/.cargo/bin/claude-memory";
const ENRICH_TIMEOUT_MS = 75_000;
const ENRICH_KILL_GRACE_MS = 1_000;
const SECTION_START = "<claude_memory_enrich>";
const SECTION_END = "</claude_memory_enrich>";

type HookOutput = {
	hookSpecificOutput?: {
		hookEventName?: string;
		additionalContext?: string;
	};
};

function isHookOutput(value: unknown): value is HookOutput {
	if (!value || typeof value !== "object") {
		return false;
	}

	const output = (value as { hookSpecificOutput?: unknown }).hookSpecificOutput;
	if (output === undefined) {
		return true;
	}

	if (!output || typeof output !== "object") {
		return false;
	}

	const maybeOutput = output as { hookEventName?: unknown; additionalContext?: unknown };
	return (
		(maybeOutput.hookEventName === undefined || typeof maybeOutput.hookEventName === "string") &&
		(maybeOutput.additionalContext === undefined || typeof maybeOutput.additionalContext === "string")
	);
}

function resolveClaudeMemoryCommand(): string | undefined {
	const configuredCommand = process.env.PI_CLAUDE_MEMORY;
	if (configuredCommand) {
		return configuredCommand;
	}

	if (existsSync(DEFAULT_CLAUDE_MEMORY)) {
		return DEFAULT_CLAUDE_MEMORY;
	}

	return undefined;
}

function parseAdditionalContext(stdout: string): string | undefined {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return undefined;
	}

	const parsed: unknown = JSON.parse(trimmed);
	if (!isHookOutput(parsed)) {
		throw new Error("claude-memory enrich returned unexpected JSON shape");
	}

	const context = parsed.hookSpecificOutput?.additionalContext?.trim();
	return context && context.length > 0 ? context : undefined;
}

type EnrichTerminationReason = "abort" | "shutdown" | "timeout";

type EnrichProcessState = {
	settled: boolean;
	terminationReason?: EnrichTerminationReason;
	error?: unknown;
	timeout?: ReturnType<typeof setTimeout>;
	graceTimeout?: ReturnType<typeof setTimeout>;
	removeAbortListener?: () => void;
};

type ActiveEnrichProcess = {
	child: ReturnType<typeof spawn>;
	state: EnrichProcessState;
	closed: Promise<void>;
	resolveClosed: () => void;
};

type EnrichRuntime = {
	activeProcesses: Set<ActiveEnrichProcess>;
	queue: Promise<void>;
	shuttingDown: boolean;
};

function createEnrichRuntime(): EnrichRuntime {
	return { activeProcesses: new Set(), queue: Promise.resolve(), shuttingDown: false };
}

function clearEnrichProcessResources(state: EnrichProcessState): void {
	if (state.timeout) clearTimeout(state.timeout);
	if (state.graceTimeout) clearTimeout(state.graceTimeout);
	state.removeAbortListener?.();
}

function requestEnrichTermination(
	process: ActiveEnrichProcess,
	reason: EnrichTerminationReason,
	error?: unknown,
): void {
	if (process.state.settled || process.state.terminationReason) return;
	process.state.terminationReason = reason;
	if (error !== undefined) process.state.error = error;
	process.child.kill("SIGTERM");
	process.state.graceTimeout = setTimeout(() => {
		if (!process.state.settled) process.child.kill("SIGKILL");
	}, ENRICH_KILL_GRACE_MS);
}

function settleEnrichProcess(
	runtime: EnrichRuntime,
	process: ActiveEnrichProcess,
	resolve: (context: string | undefined) => void,
	reject: (error: unknown) => void,
	error?: unknown,
	context?: string,
): void {
	if (process.state.settled) return;
	process.state.settled = true;
	clearEnrichProcessResources(process.state);
	runtime.activeProcesses.delete(process);
	process.resolveClosed();
	if (error !== undefined) {
		reject(error);
		return;
	}
	resolve(context);
}

function runEnrich(
	runtime: EnrichRuntime,
	command: string,
	prompt: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (signal?.aborted) {
		return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("operation aborted"));
	}

	return new Promise((resolve, reject) => {
		const child = spawn(command, ["enrich"], { stdio: ["pipe", "pipe", "pipe"] });
		const state: EnrichProcessState = { settled: false };
		let resolveClosed = (): void => {};
		const process: ActiveEnrichProcess = {
			child,
			state,
			closed: new Promise((closed) => {
				resolveClosed = closed;
			}),
			resolveClosed: () => resolveClosed(),
		};
		let stdout = "";
		let stderr = "";

		runtime.activeProcesses.add(process);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		state.timeout = setTimeout(() => requestEnrichTermination(process, "timeout"), ENRICH_TIMEOUT_MS);

		if (signal) {
			const abort = (): void => {
				requestEnrichTermination(process, "abort", new Error("operation aborted"));
			};
			signal.addEventListener("abort", abort, { once: true });
			state.removeAbortListener = () => signal.removeEventListener("abort", abort);
			if (signal.aborted) abort();
		}

		child.once("error", (error) => {
			if (state.error === undefined) state.error = error;
		});
		child.once("close", (code) => {
			if (state.terminationReason === "shutdown") {
				settleEnrichProcess(runtime, process, resolve, reject);
				return;
			}
			if (state.terminationReason === "timeout") {
				settleEnrichProcess(
					runtime,
					process,
					resolve,
					reject,
					new Error(`claude-memory enrich timed out after ${ENRICH_TIMEOUT_MS}ms`),
				);
				return;
			}
			if (state.terminationReason === "abort") {
				settleEnrichProcess(runtime, process, resolve, reject, state.error ?? new Error("operation aborted"));
				return;
			}
			if (state.error !== undefined) {
				settleEnrichProcess(runtime, process, resolve, reject, state.error);
				return;
			}
			if (code !== 0) {
				settleEnrichProcess(
					runtime,
					process,
					resolve,
					reject,
					new Error(`claude-memory enrich exited with ${code}: ${stderr.trim()}`),
				);
				return;
			}
			try {
				settleEnrichProcess(runtime, process, resolve, reject, undefined, parseAdditionalContext(stdout));
			} catch (error) {
				settleEnrichProcess(runtime, process, resolve, reject, error);
			}
		});

		child.stdin.end(`${JSON.stringify({ prompt })}\n`);
	});
}

// Ollama may serialize embedding requests, so start one timed enrich process at a time.
function queueEnrich(
	runtime: EnrichRuntime,
	command: string,
	prompt: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const enrichment = runtime.queue.then(() =>
		runtime.shuttingDown ? undefined : runEnrich(runtime, command, prompt, signal),
	);
	runtime.queue = enrichment.then(
		() => undefined,
		() => undefined,
	);
	return enrichment;
}

async function shutdownEnrichRuntime(runtime: EnrichRuntime): Promise<void> {
	runtime.shuttingDown = true;
	const activeProcesses = [...runtime.activeProcesses];
	for (const process of activeProcesses) requestEnrichTermination(process, "shutdown");
	await Promise.all(activeProcesses.map((process) => process.closed));
	await runtime.queue;
}

function appendEnrichment(systemPrompt: string, additionalContext: string): string {
	if (systemPrompt.includes(SECTION_START)) {
		return systemPrompt;
	}

	return `${systemPrompt}\n\n${SECTION_START}\n${additionalContext}\n${SECTION_END}`;
}

export default function claudeMemoryEnrichExtension(pi: ExtensionAPI): void {
	const runtime = createEnrichRuntime();

	pi.on("session_shutdown", async () => {
		await shutdownEnrichRuntime(runtime);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = event.prompt.trim();
		if (!prompt) {
			return;
		}

		const command = resolveClaudeMemoryCommand();
		if (!command) {
			return;
		}

		try {
			const additionalContext = await queueEnrich(runtime, command, prompt, ctx.signal);
			if (!additionalContext) {
				return;
			}

			return {
				systemPrompt: appendEnrichment(event.systemPrompt, additionalContext),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`claude-memory-enrich: ${message}`);
			return;
		}
	});
}
