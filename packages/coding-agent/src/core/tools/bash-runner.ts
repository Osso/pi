import { existsSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { getShellConfig, killProcessTree } from "../../utils/shell.ts";
import { type DetachedBashForegroundCompletion, writeDetachedBashActivation } from "../detached-bash-runner.ts";
import type { DetachedJobLifecycleController } from "../detached-job-runner.ts";
import { type AgentSnapshot, isActiveLifecycle } from "../multi-agent-store.ts";
import { isProcessIdentityAlive } from "../runtime-process.ts";
import type { BashDetachedResult, BashDetachOptions } from "./bash.ts";

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

type BashRunnerResult = { exitCode: number | null; detached?: BashDetachedResult };
type BashOwnership = ReturnType<DetachedJobLifecycleController["register"]>;
type LaunchedBashRunner = ReturnType<DetachedJobLifecycleController["launchBash"]>;

/** Runs a foreground bash call in a durable runner process so it can be detached into a background job. */
export async function executeRunnerOwnedBash(
	command: string,
	cwd: string,
	options: {
		detach: BashDetachOptions;
		env: NodeJS.ProcessEnv;
		lifecycle: DetachedJobLifecycleController;
		onActivated: () => void;
		onData: (data: Buffer) => void;
		shellPath?: string;
		signal?: AbortSignal;
		timeout?: number;
		timeoutMs?: number;
		toolCallId?: string;
	},
): Promise<BashRunnerResult> {
	const shell = getShellConfig(options.shellPath);
	if (shell.commandTransport === "stdin")
		throw new Error("Detached Bash runner does not support stdin shell transport");

	const restoredResult = await waitForRestoredBashJob(options);
	if (restoredResult) return restoredResult;

	const runner = options.lifecycle.launchBash({
		args: [...shell.args, command],
		command: shell.shell,
		cwd,
		env: options.env,
		timeoutMs: options.timeoutMs,
		toolCallId: options.toolCallId,
	});
	return observeForegroundBashRunner(runner, cwd, options);
}

async function waitForRestoredBashJob(options: {
	lifecycle: DetachedJobLifecycleController;
	onData: (data: Buffer) => void;
	timeout?: number;
	toolCallId?: string;
}): Promise<BashRunnerResult | undefined> {
	if (!options.toolCallId) return undefined;
	const restoredJob = options.lifecycle.findBashJobByToolCallId(options.toolCallId);
	if (!restoredJob) return undefined;

	let restoredState = restoredJob;
	while (isActiveLifecycle(restoredState.lifecycle)) {
		restoredState = options.lifecycle.observe(restoredState.id) ?? restoredState;
		if (isActiveLifecycle(restoredState.lifecycle)) await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (restoredState.lifecycle === "failed" && restoredState.error?.code === "lost_runtime") {
		return undefined;
	}
	const outputPath = restoredState.result?.fileRefs?.find((fileRef) => fileRef.label === "Bash output")?.path;
	if (outputPath && existsSync(outputPath)) options.onData(readFileSync(outputPath));
	return resultFromTerminalBashAgent(restoredState, { aborted: false, timeout: options.timeout });
}

async function observeForegroundBashRunner(
	runner: LaunchedBashRunner,
	cwd: string,
	options: {
		detach: BashDetachOptions;
		lifecycle: DetachedJobLifecycleController;
		onActivated: () => void;
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
		toolCallId?: string;
	},
): Promise<BashRunnerResult> {
	let outputOffset = 0;
	let aborted = false;
	let activation: ReturnType<typeof activateDetachedBashRunner>;
	let activationError: unknown;
	const requestCancellation = () => {
		aborted = true;
		terminateForegroundBashRunner(runner.runnerPid);
	};
	// Activate synchronously so an abort right after detach (restart teardown) finds a detached job, not a foreground runner.
	const activateOnDetach = () => {
		if (activation || readForegroundBashCompletion(runner.foregroundCompletionPath)) return;
		outputOffset = forwardBashRunnerOutput(runner, outputOffset, options.onData);
		try {
			activation = activateDetachedBashRunner(runner, cwd, options);
		} catch (error) {
			activationError = error;
		}
		if (!activation) return;
		options.signal?.removeEventListener("abort", requestCancellation);
		options.onActivated();
	};
	if (options.signal?.aborted) requestCancellation();
	else options.signal?.addEventListener("abort", requestCancellation, { once: true });
	options.detach.signal.addEventListener("abort", activateOnDetach);
	try {
		for (;;) {
			if (activationError) throw activationError;
			if (activation) return activation.result;
			outputOffset = forwardBashRunnerOutput(runner, outputOffset, options.onData);
			const completion = settleForegroundBashRunner(runner, aborted, options.timeout);
			if (completion) return completion;
			if (options.detach.signal.aborted) activateOnDetach();
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	} finally {
		options.signal?.removeEventListener("abort", requestCancellation);
		options.detach.signal.removeEventListener("abort", activateOnDetach);
	}
}

function forwardBashRunnerOutput(
	runner: LaunchedBashRunner,
	outputOffset: number,
	onData: (data: Buffer) => void,
): number {
	if (!existsSync(runner.artifacts.outputPath)) return outputOffset;
	const output = readFileSync(runner.artifacts.outputPath);
	if (output.length <= outputOffset) return outputOffset;
	onData(output.subarray(outputOffset));
	return output.length;
}

function settleForegroundBashRunner(
	runner: LaunchedBashRunner,
	aborted: boolean,
	timeout?: number,
): BashRunnerResult | undefined {
	const completion = readForegroundBashCompletion(runner.foregroundCompletionPath);
	if (completion) {
		if (completion.timedOut) throw new Error(`timeout:${timeout}`);
		if (aborted || completion.cancelReason) throw new Error("aborted");
		// A signal-killed shell has no exit code; use the shell convention 128 + signal number, as bash.ts does.
		const signalNumber = completion.signal ? osConstants.signals[completion.signal] : undefined;
		return { exitCode: completion.exitCode ?? (signalNumber ? 128 + signalNumber : 1) };
	}
	if (isProcessIdentityAlive(runner.processIdentity)) return undefined;
	const runnerErrorPath = `${runner.manifestPath}.runner-error`;
	if (existsSync(runnerErrorPath)) throw new Error(readFileSync(runnerErrorPath, "utf8").trim());
	if (aborted) throw new Error("aborted");
	throw new Error("Detached Bash runner exited without producing a result");
}

function activateDetachedBashRunner(
	runner: LaunchedBashRunner,
	cwd: string,
	options: {
		lifecycle: DetachedJobLifecycleController;
		toolCallId?: string;
	},
): { ownership: BashOwnership; result: BashRunnerResult } | undefined {
	if (!isProcessIdentityAlive(runner.processIdentity)) return undefined;
	try {
		const ownership = options.lifecycle.register({
			agentType: "bash",
			cwd,
			detached: true,
			displayName: "Bash command",
			jobId: runner.jobId,
			processIdentity: runner.processIdentity,
			toolCallId: options.toolCallId,
			workerHandleId: String(runner.runnerPid),
		});
		writeDetachedBashActivation(runner.activationPath, ownership.identity);
		return {
			ownership,
			result: {
				exitCode: null,
				detached: {
					jobId: runner.jobId,
					logPath: runner.artifacts.outputPath,
					message: `Detached bash command as background job ${runner.jobId}.`,
				},
			},
		};
	} catch (error) {
		terminateForegroundBashRunner(runner.runnerPid);
		throw error;
	}
}

export function readForegroundBashCompletion(path: string): DetachedBashForegroundCompletion | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const candidate = parsed as Record<string, unknown>;
		if (
			typeof candidate.timedOut !== "boolean" ||
			(candidate.exitCode !== null && typeof candidate.exitCode !== "number") ||
			(candidate.signal !== null && typeof candidate.signal !== "string") ||
			(candidate.cancelReason !== undefined && typeof candidate.cancelReason !== "string")
		) {
			return undefined;
		}
		return {
			...(candidate.cancelReason !== undefined ? { cancelReason: candidate.cancelReason } : {}),
			exitCode: candidate.exitCode,
			signal: candidate.signal as NodeJS.Signals | null,
			timedOut: candidate.timedOut,
		};
	} catch {
		return undefined;
	}
}

function terminateForegroundBashRunner(pid: number): void {
	killProcessTree(pid);
}
