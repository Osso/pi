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

export type PyrunPiRequestDispatcher = (
	request: { method: string; params: unknown },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
) => Promise<unknown> | unknown;

function formatResultValue(result: CanonicalPyrunEvalResult): string {
	if (result.type === "needs_approval") {
		return `needs approval: ${result.approval?.summary ?? "unknown Pyrun operation"}`;
	}
	if (result.value === undefined) {
		return "undefined";
	}
	if (typeof result.value === "string") {
		return result.value;
	}
	return JSON.stringify(result.value);
}

function formatConsoleEntry(entry: NonNullable<CanonicalPyrunEvalResult["console"]>[number]): string {
	if (typeof entry === "string") {
		return `stdout: ${entry}`;
	}
	return `${entry.level}: ${entry.message}`;
}

function formatToolText(params: PyrunEvalParams, result: CanonicalPyrunEvalResult): string {
	const lines = [params.code, "", `Session: ${params.session_id ?? "default"}`];
	for (const entry of result.console ?? []) {
		lines.push(formatConsoleEntry(entry));
	}
	if (result.error) {
		lines.push(`Error: ${result.error}`);
	} else {
		lines.push(`Result: ${formatResultValue(result)}`);
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

export function createPyrunEvalExecutor(runner: PyrunRunnerClient, dispatchPiRequest?: PyrunPiRequestDispatcher) {
	return async (
		params: PyrunEvalParams,
		ctx: ExtensionContext,
		onUpdate?: (partialResult: AgentToolResult<CanonicalPyrunEvalResult | CanonicalPyrunProgressUpdate>) => void,
		signal?: AbortSignal,
	): Promise<AgentToolResult<CanonicalPyrunEvalResult>> => {
		const onPiRequest: PyrunPiRequestHandler = async (request) => {
			if (!dispatchPiRequest) {
				throw new Error(`Pi capability is unavailable: ${request.method}`);
			}
			return dispatchPiRequest(request, ctx, signal);
		};
		const result = await runner.evaluate(
			{ ...params, pi: createPiCapabilitySnapshot(ctx), pi_bridge: true },
			(update) => {
				onUpdate?.({
					content: [{ type: "text", text: formatProgressText(update) }],
					details: update,
				});
			},
			signal,
			onPiRequest,
		);
		return {
			content: [{ type: "text", text: formatToolText(params, result) }],
			details: result,
			isError: result.error !== undefined,
		};
	};
}
