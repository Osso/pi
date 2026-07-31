import type { ChildProcess } from "node:child_process";
import { spawnProcess, waitForChildProcess } from "../../../src/utils/child-process.ts";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "../../../src/core/extensions/types.ts";
import { Type, type Static } from "typebox";

export interface BrowserCliCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
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

const browserCliSchema = Type.Object({
	args: Type.Array(Type.String({ description: "One browser-cli argument." })),
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
		description: "Run one browser-cli command using argv arguments and return its stdout.",
		promptSnippet: "Control the browser through the browser-cli executable.",
		parameters: browserCliSchema,
		approvalRequired: true,
		async execute(
			_toolCallId,
			params: BrowserCliInput,
			signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<BrowserCliCommandResult>> {
			const result = await waitForAbort(runCommand(BROWSER_CLI_EXECUTABLE, params.args, signal), signal);
			if (result.exitCode !== 0) {
				throw new Error(formatBrowserCliFailure(result));
			}
			return {
				content: [{ type: "text", text: result.stdout }],
				details: result,
			};
		},
	};
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

function formatBrowserCliFailure(result: BrowserCliCommandResult): string {
	const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
	const detail = output ? `: ${output}` : "";
	return `browser-cli exited with code ${result.exitCode ?? "unknown"}${detail}`;
}
