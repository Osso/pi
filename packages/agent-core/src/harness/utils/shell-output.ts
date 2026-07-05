import { type ExecutionEnv, ExecutionError, err, ok, type Result, type ShellExecOptions, toError } from "../types.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./truncate.ts";

export interface ShellCaptureOptions extends Omit<ShellExecOptions, "onStdout" | "onStderr"> {
	onChunk?: (chunk: string) => void;
}

export interface ShellCaptureResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

function toExecutionError(error: unknown): ExecutionError {
	if (error instanceof ExecutionError) return error;
	const cause = toError(error);
	return new ExecutionError("unknown", cause.message, cause);
}

export function sanitizeBinaryOutput(str: string): string {
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

export async function executeShellWithCapture(
	env: ExecutionEnv,
	command: string,
	options?: ShellCaptureOptions,
): Promise<Result<ShellCaptureResult, ExecutionError>> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
	const encoder = new TextEncoder();

	let totalBytes = 0;
	let fullOutputPath: string | undefined;
	let fullOutputRequested = false;
	let pendingFullOutput = "";
	let writeChain: Promise<Result<void, ExecutionError>> = Promise.resolve(ok(undefined));
	let captureError: ExecutionError | undefined;

	const appendFullOutput = (text: string): void => {
		if (captureError) return;
		if (!fullOutputPath) {
			if (fullOutputRequested) pendingFullOutput += text;
			return;
		}
		const path = fullOutputPath;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			const appendResult = await env.appendFile(path, text, options?.abortSignal);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	const ensureFullOutputFile = (initialContent: string): void => {
		if (fullOutputRequested || captureError) return;
		fullOutputRequested = true;
		pendingFullOutput = initialContent;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			const tempFile = await env.createTempFile({
				prefix: "bash-",
				suffix: ".log",
				abortSignal: options?.abortSignal,
			});
			if (!tempFile.ok) return err(toExecutionError(tempFile.error));
			fullOutputPath = tempFile.value;
			const initialOutput = pendingFullOutput;
			pendingFullOutput = "";
			const appendResult = await env.appendFile(tempFile.value, initialOutput, options?.abortSignal);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	const onChunk = (chunk: string) => {
		try {
			totalBytes += encoder.encode(chunk).byteLength;
			const text = sanitizeBinaryOutput(chunk).replace(/\r/g, "");
			if (totalBytes > DEFAULT_MAX_BYTES && !fullOutputRequested) {
				ensureFullOutputFile(outputChunks.join("") + text);
			} else {
				appendFullOutput(text);
			}
			outputChunks.push(text);
			outputBytes += text.length;
			while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
				const removed = outputChunks.shift()!;
				outputBytes -= removed.length;
			}
			options?.onChunk?.(text);
		} catch (error) {
			captureError = toExecutionError(error);
		}
	};

	try {
		const result = await env.exec(command, {
			...(options ?? {}),
			onStdout: onChunk,
			onStderr: onChunk,
		});
		const tailOutput = outputChunks.join("");
		const truncationResult = truncateTail(tailOutput);
		if (truncationResult.truncated && !fullOutputRequested) {
			ensureFullOutputFile(tailOutput);
		}
		const writeResult = await writeChain;
		if (!writeResult.ok) return err(writeResult.error);
		if (captureError) return err(captureError);

		const truncated = truncationResult.truncated || fullOutputRequested;
		const output = truncationResult.truncated ? truncationResult.content : tailOutput;

		if (!result.ok) {
			if (result.error.code === "aborted" || options?.abortSignal?.aborted) {
				return ok({
					output,
					exitCode: undefined,
					cancelled: true,
					truncated,
					fullOutputPath,
				});
			}
			return err(result.error);
		}
		const cancelled = options?.abortSignal?.aborted ?? false;
		return ok({
			output,
			exitCode: cancelled ? undefined : result.value.exitCode,
			cancelled,
			truncated,
			fullOutputPath,
		});
	} catch (error) {
		return err(toExecutionError(error));
	}
}
