import type { ChildProcess } from "node:child_process";
import { spawnProcess, waitForChildProcess } from "../../../src/utils/child-process.ts";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "../../../src/core/extensions/types.ts";
import { Type, type Static } from "typebox";

export interface BrowserCliCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export interface BrowserCliCommandExecution extends BrowserCliCommandResult {
	args: string[];
}

export interface BrowserCliBatchResult {
	commands: BrowserCliCommandExecution[];
}

export type BrowserCliCommandRunner = (
	executable: string,
	args: string[],
	signal?: AbortSignal,
) => Promise<BrowserCliCommandResult>;

export interface BrowserCliExtensionOptions {
	runCommand?: BrowserCliCommandRunner;
}

const BROWSER_CLI_EXECUTABLE = "browser-cli";

const BROWSER_CLI_PROMPT_GUIDELINES = [
	'When spawn_agent is available, use a fresh agentType "browser" for multi-step browser workflows; direct browser-cli use remains allowed for simple actions.',
	"Pass deterministic command sequences in one ordered commands batch. Use separate calls when an intermediate result determines the next action.",
	"Observe with snapshot --interactive --compact before interacting. Re-observe after navigation or page mutation instead of repeatedly guessing selectors.",
	"Use open for navigation; fill, click, and press for interaction. `press` takes only a key, not a selector. Wait for bounded delays or selectors; use get url, get title, and visible text for completion proof.",
	"When a login form appears, attempt mapped authentication with broker-unlock --current-origin followed by broker-fill --current-origin. Never request or pass credential values.",
	"After broker fill, inspect the page, click the sign-in control, and verify the resulting authenticated state. Stop for user action when MFA or CAPTCHA appears.",
];

const browserCliCommandSchema = Type.Array(Type.String({ description: "One browser-cli argument." }), {
	minItems: 1,
});

const browserCliSchema = Type.Object({
	commands: Type.Array(browserCliCommandSchema, {
		description: "Ordered browser-cli argv commands to execute sequentially.",
		minItems: 1,
	}),
});

type BrowserCliInput = Static<typeof browserCliSchema>;

export default function browserCliExtension(pi: ExtensionAPI, options: BrowserCliExtensionOptions = {}): void {
	pi.registerTool(createBrowserCliToolDefinition(options));
}

export function createBrowserCliToolDefinition(
	options: BrowserCliExtensionOptions = {},
): ToolDefinition<typeof browserCliSchema> {
	const runCommand = options.runCommand ?? runBrowserCliCommand;
	return {
		name: "browser-cli",
		label: "Browser CLI",
		description: "Run ordered browser-cli argv commands sequentially and return each command result.",
		promptSnippet: "Control the browser through ordered browser-cli command batches.",
		promptGuidelines: BROWSER_CLI_PROMPT_GUIDELINES,
		parameters: browserCliSchema,
		approvalRequired: true,
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params: BrowserCliInput,
			signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<BrowserCliBatchResult>> {
			const commands = await runBrowserCliBatch(runCommand, params.commands, signal);
			return {
				content: [{ type: "text", text: formatBrowserCliBatchOutput(commands) }],
				details: { commands },
			};
		},
	};
}

async function runBrowserCliBatch(
	runCommand: BrowserCliCommandRunner,
	commands: string[][],
	signal?: AbortSignal,
): Promise<BrowserCliCommandExecution[]> {
	const results: BrowserCliCommandExecution[] = [];
	for (const [index, args] of commands.entries()) {
		const result = await waitForAbort(runCommand(BROWSER_CLI_EXECUTABLE, args, signal), signal);
		const execution = { args: [...args], ...result };
		if (result.exitCode !== 0) {
			throw new Error(formatBrowserCliFailure(index, execution));
		}
		results.push(execution);
	}
	return results;
}

async function runBrowserCliCommand(
	executable: string,
	args: string[],
	signal?: AbortSignal,
): Promise<BrowserCliCommandResult> {
	throwIfAborted(signal);
	const child = spawnProcess(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let aborted = false;
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const onAbort = () => {
		aborted = true;
		terminateChild(child);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const exitCode = await waitForChildProcess(child);
		if (aborted || signal?.aborted) throw createAbortError();
		return { stdout, stderr, exitCode };
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(createAbortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(createAbortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
	return new Error("browser-cli command aborted");
}

function terminateChild(child: ChildProcess): void {
	if (!child.killed) child.kill();
}

function formatBrowserCliBatchOutput(commands: BrowserCliCommandExecution[]): string {
	return commands
		.flatMap((command) => [command.stdout, command.stderr])
		.filter(Boolean)
		.join("");
}

function formatBrowserCliFailure(index: number, result: BrowserCliCommandExecution): string {
	const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
	const detail = output ? `: ${output}` : "";
	return `browser-cli command ${index + 1} exited with code ${result.exitCode ?? "unknown"}${detail}`;
}
