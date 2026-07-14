import { closeSync, constants, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type ChildProcess, spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { DetachedJobArtifacts, DetachedJobLifecycleController } from "../detached-job-runner.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { type AgentSnapshot, isActiveLifecycle, type MultiAgentStore } from "../multi-agent-store.ts";
import { type ToolDetachHandle, ToolDetachRegistry } from "../tool-detach-registry.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	backgroundJobId?: string;
}

export interface BashDetachedResult {
	jobId: string;
	message: string;
	logPath?: string;
}

export interface DetachedBashProcess {
	artifacts?: DetachedJobArtifacts;
	child: ChildProcess;
	command: string;
	cwd: string;
	exit: Promise<number | null>;
	pid?: number;
	startedAt: number;
	timeoutHandle?: NodeJS.Timeout;
}

export interface BashDetachOptions {
	artifacts?: DetachedJobArtifacts;
	jobId?: string;
	signal: AbortSignal;
	adopt?: (process: DetachedBashProcess) => Promise<BashDetachedResult> | BashDetachedResult;
}

export interface BashBackgroundJobsOptions {
	getLifecycle?: () => DetachedJobLifecycleController | undefined;
	lifecycle?: DetachedJobLifecycleController;
	store: MultiAgentStore;
}

export type BashToolDetachHandle = ToolDetachHandle;
export class BashToolDetachRegistry extends ToolDetachRegistry {}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			detach?: BashDetachOptions;
		},
	) => Promise<{ exitCode: number | null; detached?: BashDetachedResult }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env, detach }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const outputDescriptor = detach?.artifacts ? openSync(detach.artifacts.outputPath, "w", 0o600) : undefined;
			let child: ChildProcess;
			try {
				child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: [commandFromStdin ? "pipe" : "ignore", outputDescriptor ?? "pipe", outputDescriptor ?? "pipe"],
					windowsHide: true,
				});
			} finally {
				if (outputDescriptor !== undefined) closeSync(outputDescriptor);
			}
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			let detached = false;
			let outputOffset = 0;
			let outputTail: NodeJS.Timeout | undefined;
			const pollDurableOutput = () => {
				if (!detach?.artifacts) return;
				const output = readFileSync(detach.artifacts.outputPath);
				if (output.length <= outputOffset) return;
				onData(output.subarray(outputOffset));
				outputOffset = output.length;
			};
			if (detach?.artifacts) outputTail = setInterval(pollDurableOutput, 25);
			let removeDetachListener: (() => void) | undefined;

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exit = waitForChildProcess(child);
				const detachResult = detach
					? new Promise<{ detached: true; result: BashDetachedResult }>((resolve, reject) => {
							const onDetach = () => {
								pollDurableOutput();
								if (outputTail) clearInterval(outputTail);
								outputTail = undefined;
								child.stdout?.off("data", onData);
								child.stderr?.off("data", onData);
								Promise.resolve(
									detach.adopt?.({
										child,
										command,
										cwd,
										exit,
										pid: child.pid,
										startedAt: Date.now(),
										timeoutHandle,
									}) ?? { jobId: "background", message: "Background job started" },
								).then((result) => resolve({ detached: true, result }), reject);
							};
							if (detach.signal.aborted) onDetach();
							else detach.signal.addEventListener("abort", onDetach, { once: true });
							removeDetachListener = () => detach.signal.removeEventListener("abort", onDetach);
						})
					: undefined;
				const settled = detachResult
					? await Promise.race([exit.then((exitCode) => ({ detached: false as const, exitCode })), detachResult])
					: { detached: false as const, exitCode: await exit };
				if (settled.detached) {
					detached = true;
					return { exitCode: null, detached: settled.result };
				}
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode: settled.exitCode };
			} finally {
				removeDetachListener?.();
				if (outputTail) clearInterval(outputTail);
				if (!detached && detach?.artifacts) rmSync(detach.artifacts.directory, { force: true, recursive: true });
				if (!detached && child.pid) untrackDetachedChildPid(child.pid);
				if (!detached && timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/** Signal used to detach an in-flight bash command into a background job. */
	detach?: BashDetachOptions;
	/** Registry used by interactive controls to detach in-flight bash tool calls. */
	detachRegistry?: BashToolDetachRegistry;
	/** Multi-agent store used to track detached local bash commands as background jobs. */
	backgroundJobs?: BashBackgroundJobsOptions;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function createDetachOptions(
	detachController: AbortController | undefined,
	lifecycle: DetachedJobLifecycleController | undefined,
): BashDetachOptions | undefined {
	if (!detachController || !lifecycle) return undefined;
	return { signal: detachController.signal };
}

function resultFromTerminalBashAgent(
	agent: AgentSnapshot,
	options: { aborted: boolean; timeout?: number },
): { exitCode: number | null } {
	if (options.aborted || agent.lifecycle === "aborted") throw new Error("aborted");
	if (agent.lifecycle === "failed" && agent.error?.message.includes("timed out")) {
		throw new Error(`timeout:${options.timeout}`);
	}
	return { exitCode: agent.lifecycle === "completed" ? 0 : 1 };
}

async function executeRunnerOwnedBash(
	command: string,
	cwd: string,
	options: {
		detach: BashDetachOptions;
		env: NodeJS.ProcessEnv;
		lifecycle: DetachedJobLifecycleController;
		onData: (data: Buffer) => void;
		shellPath?: string;
		signal?: AbortSignal;
		timeout?: number;
		toolCallId?: string;
	},
): Promise<{ exitCode: number | null; detached?: BashDetachedResult }> {
	const shell = getShellConfig(options.shellPath);
	if (shell.commandTransport === "stdin")
		throw new Error("Detached Bash runner does not support stdin shell transport");
	const restoredJob = options.toolCallId ? options.lifecycle.findBashJobByToolCallId(options.toolCallId) : undefined;
	if (restoredJob && (restoredJob.lifecycle === "cancelling" || restoredJob.lifecycle === "aborted")) {
		let restoredState = restoredJob;
		while (isActiveLifecycle(restoredState.lifecycle)) {
			restoredState = options.lifecycle.observe(restoredState.id) ?? restoredState;
			if (isActiveLifecycle(restoredState.lifecycle)) await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const outputPath = restoredState.result?.fileRefs?.find((fileRef) => fileRef.label === "Bash output")?.path;
		if (outputPath && existsSync(outputPath)) options.onData(readFileSync(outputPath));
		return resultFromTerminalBashAgent(restoredState, { aborted: false, timeout: options.timeout });
	}
	const launched = options.lifecycle.launchBash({
		args: [...shell.args, command],
		command: shell.shell,
		cwd,
		env: options.env,
		timeoutMs: resolveTimeoutMs(options.timeout),
		toolCallId: options.toolCallId,
	});
	let outputOffset = 0;
	let aborted = false;
	let terminalAgent: AgentSnapshot | undefined;
	const requestCancellation = () => {
		aborted = true;
		options.lifecycle.cancel(launched.ownership, "Bash tool call aborted");
	};
	if (options.signal?.aborted) requestCancellation();
	else options.signal?.addEventListener("abort", requestCancellation, { once: true });
	try {
		for (;;) {
			const output = existsSync(launched.ownership.artifacts.outputPath)
				? readFileSync(launched.ownership.artifacts.outputPath)
				: Buffer.alloc(0);
			if (output.length > outputOffset) {
				options.onData(output.subarray(outputOffset));
				outputOffset = output.length;
			}
			terminalAgent = options.lifecycle.observe(launched.ownership.agent.id);
			if (terminalAgent && !isActiveLifecycle(terminalAgent.lifecycle)) break;
			if (options.detach.signal.aborted) {
				return {
					exitCode: null,
					detached: {
						jobId: launched.ownership.agent.id,
						logPath: launched.ownership.artifacts.outputPath,
						message: `Detached bash command as background job ${launched.ownership.agent.id}.`,
					},
				};
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (!terminalAgent) throw new Error("Detached Bash job terminal state is unavailable");
		return resultFromTerminalBashAgent(terminalAgent, { aborted, timeout: options.timeout });
	} finally {
		options.signal?.removeEventListener("abort", requestCancellation);
	}
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const configuredDetach = options?.detach;
	const detachRegistry = options?.detachRegistry;
	const backgroundJobs = options?.backgroundJobs;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		async execute(
			toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
			const lifecycle = backgroundJobs?.getLifecycle?.() ?? backgroundJobs?.lifecycle;
			const detachController = configuredDetach || !lifecycle || !detachRegistry ? undefined : new AbortController();
			let unregisterDetach: (() => void) | undefined;
			const detach = configuredDetach ?? createDetachOptions(detachController, lifecycle);
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			const formatDetachedOutput = (
				snapshot: Awaited<ReturnType<typeof finishOutput>>,
				detached: BashDetachedResult,
			) => {
				const { text } = formatOutput(snapshot, "");
				const details: BashToolDetails = { backgroundJobId: detached.jobId };
				if (detached.logPath) details.fullOutputPath = detached.logPath;
				return {
					content: [
						{
							type: "text" as const,
							text: appendStatus(
								text.trimEnd(),
								`Command moved to background as job ${detached.jobId}. ${detached.message}`,
							),
						},
					],
					details,
				};
			};

			if (detachController) {
				unregisterDetach = detachRegistry?.register({
					detach: () => {
						if (detachController.signal.aborted) {
							return false;
						}
						detachController.abort();
						return true;
					},
				});
			}

			try {
				let exitCode: number | null;
				try {
					const useDetachedRunner =
						options?.operations === undefined && lifecycle !== undefined && detach !== undefined;
					const result = useDetachedRunner
						? await executeRunnerOwnedBash(spawnContext.command, spawnContext.cwd, {
								detach,
								env: spawnContext.env,
								lifecycle,
								onData: handleData,
								shellPath: options?.shellPath,
								signal,
								timeout,
								toolCallId,
							})
						: await ops.exec(spawnContext.command, spawnContext.cwd, {
								onData: handleData,
								signal,
								timeout,
								env: spawnContext.env,
								detach,
							});
					if (result.detached) {
						const snapshot = await finishOutput();
						return formatDetachedOutput(snapshot, result.detached);
					}
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				unregisterDetach?.();
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
