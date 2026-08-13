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

type EnrichProcessState = {
	settled: boolean;
	timedOut: boolean;
	timeout?: ReturnType<typeof setTimeout>;
	graceTimeout?: ReturnType<typeof setTimeout>;
};

function clearEnrichTimers(state: EnrichProcessState): void {
	if (state.timeout) clearTimeout(state.timeout);
	if (state.graceTimeout) clearTimeout(state.graceTimeout);
}

function requestEnrichTermination(child: ReturnType<typeof spawn>, state: EnrichProcessState): void {
	if (state.settled || state.timedOut) return;
	state.timedOut = true;
	child.kill("SIGTERM");
	state.graceTimeout = setTimeout(() => {
		if (!state.settled) child.kill("SIGKILL");
	}, ENRICH_KILL_GRACE_MS);
}

function settleEnrichProcess(
	state: EnrichProcessState,
	resolve: (context: string | undefined) => void,
	reject: (error: unknown) => void,
	error?: unknown,
	context?: string,
): void {
	if (state.settled) return;
	state.settled = true;
	clearEnrichTimers(state);
	if (error !== undefined) {
		reject(error);
		return;
	}
	resolve(context);
}

function runEnrich(command: string, prompt: string, signal?: AbortSignal): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, ["enrich"], { stdio: ["pipe", "pipe", "pipe"], signal });
		const state: EnrichProcessState = { settled: false, timedOut: false };
		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => (stdout += chunk));
		child.stderr.on("data", (chunk: string) => (stderr += chunk));
		state.timeout = setTimeout(() => requestEnrichTermination(child, state), ENRICH_TIMEOUT_MS);

		child.once("error", (error) => {
			if (!state.timedOut) settleEnrichProcess(state, resolve, reject, error);
		});
		child.once("close", (code) => {
			if (state.timedOut) {
				settleEnrichProcess(
					state,
					resolve,
					reject,
					new Error(`claude-memory enrich timed out after ${ENRICH_TIMEOUT_MS}ms`),
				);
				return;
			}
			if (code !== 0) {
				settleEnrichProcess(
					state,
					resolve,
					reject,
					new Error(`claude-memory enrich exited with ${code}: ${stderr.trim()}`),
				);
				return;
			}
			try {
				settleEnrichProcess(state, resolve, reject, undefined, parseAdditionalContext(stdout));
			} catch (error) {
				settleEnrichProcess(state, resolve, reject, error);
			}
		});

		child.stdin.end(`${JSON.stringify({ prompt })}\n`);
	});
}

// Ollama may serialize embedding requests, so start one timed enrich process at a time.
let enrichQueue: Promise<void> = Promise.resolve();

function queueEnrich(command: string, prompt: string, signal?: AbortSignal): Promise<string | undefined> {
	const enrichment = enrichQueue.then(() => runEnrich(command, prompt, signal));
	enrichQueue = enrichment.then(
		() => undefined,
		() => undefined,
	);
	return enrichment;
}

function appendEnrichment(systemPrompt: string, additionalContext: string): string {
	if (systemPrompt.includes(SECTION_START)) {
		return systemPrompt;
	}

	return `${systemPrompt}\n\n${SECTION_START}\n${additionalContext}\n${SECTION_END}`;
}

export default function claudeMemoryEnrichExtension(pi: ExtensionAPI): void {
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
			const additionalContext = await queueEnrich(command, prompt, ctx.signal);
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
