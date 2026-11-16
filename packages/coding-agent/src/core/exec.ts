/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	/** Exit code, or 128 + signal number when a signal terminated the command (143 for SIGTERM). */
	code: number;
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		// A multi-byte UTF-8 character can be split between chunks; decoding each chunk alone corrupts it.
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work. `proc.killed` only records that a
				// signal was sent, so check whether the process has actually exited.
				setTimeout(() => {
					if (proc.exitCode === null && proc.signalCode === null) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += stdoutDecoder.write(data);
		});

		proc.stderr?.on("data", (data) => {
			stderr += stderrDecoder.write(data);
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				if (timeoutId) clearTimeout(timeoutId);
				stdout += stdoutDecoder.end();
				stderr += stderrDecoder.end();
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				// A signal-killed command has no exit code. Use the shell convention, as the bash tool does, so a
				// timeout, an abort or a crash does not read as success.
				const exitCode = code ?? (proc.signalCode ? 128 + (osConstants.signals[proc.signalCode] ?? 0) : 1);
				resolve({ stdout, stderr, code: exitCode, killed });
			})
			.catch((error: Error) => {
				if (timeoutId) clearTimeout(timeoutId);
				stdout += stdoutDecoder.end();
				stderr += stderrDecoder.end();
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr: stderr || error.message, code: 1, killed });
			});
	});
}
