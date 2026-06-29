import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const DEFAULT_CLAUDE_MEMORY = "/home/osso/.cargo/bin/claude-memory";
const TIMEOUT_MS = 15_000;
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

function runEnrich(command: string, prompt: string, signal?: AbortSignal): Promise<string | undefined> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, ["enrich"], {
			stdio: ["pipe", "pipe", "pipe"],
			signal,
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const timeout = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			child.kill("SIGTERM");
			reject(new Error(`claude-memory enrich timed out after ${TIMEOUT_MS}ms`));
		}, TIMEOUT_MS);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.once("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});

		child.once("close", (code) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);

			if (code !== 0) {
				reject(new Error(`claude-memory enrich exited with ${code}: ${stderr.trim()}`));
				return;
			}

			try {
				resolve(parseAdditionalContext(stdout));
			} catch (error) {
				reject(error);
			}
		});

		child.stdin.end(`${JSON.stringify({ prompt })}\n`);
	});
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
			const additionalContext = await runEnrich(command, prompt, ctx.signal);
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
