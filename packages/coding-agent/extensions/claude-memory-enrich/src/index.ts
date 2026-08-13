import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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
	child: ChildProcessWithoutNullStreams;
	state: EnrichProcessState;
	closed: Promise<void>;
	resolveClosed: () => void;
};

type EnrichRuntime = {
	activeProcesses: Set<ActiveEnrichProcess>;
	queue: Promise<void>;
	shuttingDown: boolean;
};

type EnrichOutput = {
	stdout: string;
	stderr: string;
};

type EnrichOutcome = {
	context?: string;
	error?: unknown;
};

type EnrichExecution = {
	runtime: EnrichRuntime;
	activeProcess: ActiveEnrichProcess;
	resolve: (context: string | undefined) => void;
	reject: (error: unknown) => void;
};

function createEnrichRuntime(): EnrichRuntime {
	return { activeProcesses: new Set(), queue: Promise.resolve(), shuttingDown: false };
}

function createActiveEnrichProcess(child: ChildProcessWithoutNullStreams): ActiveEnrichProcess {
	let resolveClosed = (): void => {};
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	return {
		child,
		state: { settled: false },
		closed,
		resolveClosed: () => resolveClosed(),
	};
}

function clearEnrichProcessResources(state: EnrichProcessState): void {
	if (state.timeout) clearTimeout(state.timeout);
	if (state.graceTimeout) clearTimeout(state.graceTimeout);
	state.removeAbortListener?.();
}

function requestEnrichTermination(
	activeProcess: ActiveEnrichProcess,
	reason: EnrichTerminationReason,
	error?: unknown,
): void {
	if (activeProcess.state.settled || activeProcess.state.terminationReason) return;
	activeProcess.state.terminationReason = reason;
	if (error !== undefined) activeProcess.state.error = error;
	activeProcess.child.kill("SIGTERM");
	activeProcess.state.graceTimeout = setTimeout(() => {
		if (!activeProcess.state.settled) activeProcess.child.kill("SIGKILL");
	}, ENRICH_KILL_GRACE_MS);
}

function settleEnrichProcess(execution: EnrichExecution, outcome: EnrichOutcome): void {
	const { activeProcess, runtime } = execution;
	if (activeProcess.state.settled) return;
	activeProcess.state.settled = true;
	clearEnrichProcessResources(activeProcess.state);
	runtime.activeProcesses.delete(activeProcess);
	activeProcess.resolveClosed();
	if (outcome.error !== undefined) {
		execution.reject(outcome.error);
		return;
	}
	execution.resolve(outcome.context);
}

function captureEnrichOutput(child: ChildProcessWithoutNullStreams): EnrichOutput {
	const output: EnrichOutput = { stdout: "", stderr: "" };
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => (output.stdout += chunk));
	child.stderr.on("data", (chunk: string) => (output.stderr += chunk));
	return output;
}

function registerEnrichAbort(activeProcess: ActiveEnrichProcess, signal?: AbortSignal): void {
	if (!signal) return;
	const abort = (): void => {
		requestEnrichTermination(activeProcess, "abort", new Error("operation aborted"));
	};
	signal.addEventListener("abort", abort, { once: true });
	activeProcess.state.removeAbortListener = () => signal.removeEventListener("abort", abort);
	if (signal.aborted) abort();
}

function interpretEnrichClose(
	activeProcess: ActiveEnrichProcess,
	code: number | null,
	output: EnrichOutput,
): EnrichOutcome {
	const { error, terminationReason } = activeProcess.state;
	if (terminationReason === "shutdown") return {};
	if (terminationReason === "timeout") {
		return { error: new Error(`claude-memory enrich timed out after ${ENRICH_TIMEOUT_MS}ms`) };
	}
	if (terminationReason === "abort") return { error: error ?? new Error("operation aborted") };
	if (error !== undefined) return { error };
	if (code !== 0) return { error: new Error(`claude-memory enrich exited with ${code}: ${output.stderr.trim()}`) };
	try {
		const context = parseAdditionalContext(output.stdout);
		return context === undefined ? {} : { context };
	} catch (parseError) {
		return { error: parseError };
	}
}

function registerEnrichProcess(execution: EnrichExecution, signal?: AbortSignal): void {
	const { activeProcess, runtime } = execution;
	const output = captureEnrichOutput(activeProcess.child);
	runtime.activeProcesses.add(activeProcess);
	activeProcess.state.timeout = setTimeout(
		() => requestEnrichTermination(activeProcess, "timeout"),
		ENRICH_TIMEOUT_MS,
	);
	registerEnrichAbort(activeProcess, signal);
	activeProcess.child.once("error", (error) => {
		if (activeProcess.state.error === undefined) activeProcess.state.error = error;
	});
	activeProcess.child.once("close", (code) => {
		settleEnrichProcess(execution, interpretEnrichClose(activeProcess, code, output));
	});
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
		const activeProcess = createActiveEnrichProcess(child);
		registerEnrichProcess({ runtime, activeProcess, resolve, reject }, signal);
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
