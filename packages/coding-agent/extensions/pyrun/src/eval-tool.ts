import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	PyrunRunnerClient,
	type CanonicalPyrunEvalResult,
	type CanonicalPyrunProgressUpdate,
	type PyrunPiRequestHandler,
} from "./runner.ts";

export interface PyrunEvalParams {
	code: string;
	session_id?: string;
}

export interface PyrunPiCapabilitySnapshot {
	footer: {
		availableProviderCount: number;
		branch: string | null;
		contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
		cwd: string;
		extensionStatuses: Record<string, string>;
		model: string | null;
		sessionName: string | null;
	};
}

export interface PyrunEvalContext {
	footerData?: ExtensionContext["footerData"];
	getContextUsage: ExtensionContext["getContextUsage"];
	model: ExtensionContext["model"];
	sessionManager: Pick<ExtensionContext["sessionManager"], "getCwd" | "getSessionName">;
}

export interface PyrunPiRequestDispatcher {
	(
		request: { method: string; params: unknown },
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
	): Promise<unknown> | unknown;
	dispose?(): void;
}

const STREAMED_CONSOLE_LINE_LIMIT = 300;
const STREAMED_CONSOLE_BYTE_LIMIT = 1_048_576;

function capConsoleText(text: string, byteLimit = STREAMED_CONSOLE_BYTE_LIMIT): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= byteLimit) return text;
	let start = bytes.length - byteLimit;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
	return bytes.subarray(start).toString("utf8");
}

function appendCappedConsoleText(existingText: string, newText: string): string {
	const text = `${capConsoleText(existingText)}${capConsoleText(newText)}`;
	const hasTrailingNewline = text.endsWith("\n");
	const lines = text.split("\n");
	if (hasTrailingNewline) {
		lines.pop();
	}
	const cappedText = lines.slice(-STREAMED_CONSOLE_LINE_LIMIT).join("\n");
	return capConsoleText(hasTrailingNewline ? `${cappedText}\n` : cappedText);
}

function formatResultValue(result: CanonicalPyrunEvalResult): string | undefined {
	if (result.type === "needs_approval") {
		return `needs approval: ${result.approval?.summary ?? "unknown Pyrun operation"}`;
	}
	const commandExitCode = getCommandResultExitCode(result.value);
	if (commandExitCode === 0) {
		return undefined;
	}
	if (commandExitCode !== undefined) {
		return `exit code ${commandExitCode}`;
	}
	if (result.value === undefined || result.value === null) {
		return undefined;
	}
	if (typeof result.value === "string") {
		return result.value.trim().length > 0 ? result.value : undefined;
	}
	return JSON.stringify(result.value);
}

function getCommandResultExitCode(value: unknown): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const hasCommandOutput = typeof record.stdout === "string" && typeof record.stderr === "string";
	return hasCommandOutput && typeof record.exit_code === "number" ? record.exit_code : undefined;
}

function formatConsoleEntry(entry: NonNullable<CanonicalPyrunEvalResult["console"]>[number]): string {
	if (typeof entry === "string") {
		return entry;
	}
	return `${entry.level}: ${entry.message}`;
}

function capConsoleHistory(
	entries: NonNullable<CanonicalPyrunEvalResult["console"]>,
): NonNullable<CanonicalPyrunEvalResult["console"]> {
	let remainingBytes = STREAMED_CONSOLE_BYTE_LIMIT;
	const boundedEntries: NonNullable<CanonicalPyrunEvalResult["console"]> = [];
	for (
		let index = entries.length - 1;
		index >= 0 && boundedEntries.length < STREAMED_CONSOLE_LINE_LIMIT && remainingBytes > 0;
		index -= 1
	) {
		const entry = entries[index];
		const entryText = typeof entry === "string" ? entry : entry.message;
		const text = capConsoleText(entryText, remainingBytes);
		remainingBytes -= Buffer.byteLength(text);
		boundedEntries.push(typeof entry === "string" ? text : { ...entry, message: text });
	}
	return boundedEntries.reverse();
}

function boundConsoleResult(result: CanonicalPyrunEvalResult): CanonicalPyrunEvalResult {
	return result.console ? { ...result, console: capConsoleHistory(result.console) } : result;
}

function formatToolText(params: PyrunEvalParams, result: CanonicalPyrunEvalResult): string {
	const lines = [params.code, ""];
	for (const entry of result.console ?? []) {
		lines.push(formatConsoleEntry(entry));
	}
	if (result.error) {
		lines.push(`Error: ${result.error}`);
	} else {
		const formattedResult = formatResultValue(result);
		if (formattedResult !== undefined) {
			lines.push(formattedResult);
		}
	}
	return lines.join("\n");
}

function formatProgressText(update: CanonicalPyrunProgressUpdate): string {
	if (update.type === "pi_request" && typeof update.method === "string") {
		return `Pi request: ${update.method}`;
	}
	if (typeof update.message === "string") {
		return update.message;
	}
	if (typeof update.text === "string") {
		return update.text;
	}
	if (typeof update.output === "string") {
		return update.output;
	}
	if (typeof update.status === "string") {
		return update.status;
	}
	if (update.value !== undefined) {
		return typeof update.value === "string" ? update.value : JSON.stringify(update.value);
	}
	return update.type;
}

function createPiCapabilitySnapshot(ctx: PyrunEvalContext): PyrunPiCapabilitySnapshot {
	const footerData = ctx.footerData;
	return {
		footer: {
			availableProviderCount: footerData?.getAvailableProviderCount() ?? 0,
			branch: footerData?.getGitBranch() ?? null,
			contextUsage: ctx.getContextUsage(),
			cwd: ctx.sessionManager.getCwd(),
			extensionStatuses: Object.fromEntries(footerData?.getExtensionStatuses() ?? []),
			model: ctx.model?.id ?? null,
			sessionName: ctx.sessionManager.getSessionName() ?? null,
		},
	};
}

export function createCanonicalPyrunEvalParams(
	params: PyrunEvalParams,
	ctx: PyrunEvalContext,
	piBridgeEnabled: boolean,
) {
	return {
		...params,
		pi: piBridgeEnabled ? createPiCapabilitySnapshot(ctx) : undefined,
		pi_bridge: piBridgeEnabled,
		stream_console: true,
	};
}

export function formatCanonicalPyrunEvalResult(
	params: PyrunEvalParams,
	result: CanonicalPyrunEvalResult,
): AgentToolResult<CanonicalPyrunEvalResult> {
	const boundedResult = boundConsoleResult(result);
	return {
		content: [{ type: "text", text: formatToolText(params, boundedResult) }],
		details: boundedResult,
		isError: boundedResult.error !== undefined,
	};
}

export interface PyrunEvalExecutorOptions {
	enablePiBridge?: boolean;
}

export type PyrunProgressUpdateCallback = (
	partialResult: AgentToolResult<CanonicalPyrunEvalResult | CanonicalPyrunProgressUpdate>,
) => void;

function boundProgressUpdate(update: CanonicalPyrunProgressUpdate): CanonicalPyrunProgressUpdate {
	if (update.type !== "console" || typeof update.text !== "string") return update;
	return { ...update, text: capConsoleText(update.text) };
}

export function createPyrunProgressReporter(
	onUpdate: PyrunProgressUpdateCallback | undefined,
): (update: CanonicalPyrunProgressUpdate) => void {
	let streamedConsoleText = "";
	return (update) => {
		const boundedUpdate = boundProgressUpdate(update);
		const formattedProgressText = formatProgressText(boundedUpdate);
		const progressText =
			boundedUpdate.type === "console"
				? appendCappedConsoleText(streamedConsoleText, formattedProgressText)
				: formattedProgressText;
		if (boundedUpdate.type === "console") {
			streamedConsoleText = progressText;
		}
		onUpdate?.({
			content: [{ type: "text", text: progressText }],
			details: boundedUpdate,
		});
	};
}

export function createPyrunEvalExecutor(
	runner: PyrunRunnerClient,
	dispatchPiRequest?: PyrunPiRequestDispatcher,
	options: PyrunEvalExecutorOptions = {},
) {
	return async (
		params: PyrunEvalParams,
		ctx: ExtensionContext,
		onUpdate?: (partialResult: AgentToolResult<CanonicalPyrunEvalResult | CanonicalPyrunProgressUpdate>) => void,
		signal?: AbortSignal,
	): Promise<AgentToolResult<CanonicalPyrunEvalResult>> => {
		const piBridgeEnabled = options.enablePiBridge ?? true;
		const onPiRequest: PyrunPiRequestHandler | undefined = piBridgeEnabled
			? async (request) => {
					if (!dispatchPiRequest) {
						throw new Error(`Pi capability is unavailable: ${request.method}`);
					}
					return dispatchPiRequest(request, ctx, signal);
				}
			: undefined;
		const result = await runner.evaluate(
			createCanonicalPyrunEvalParams(params, ctx, piBridgeEnabled),
			createPyrunProgressReporter(onUpdate),
			signal,
			onPiRequest,
		);
		return formatCanonicalPyrunEvalResult(params, result);
	};
}
