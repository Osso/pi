import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	HostrunRunnerClient,
	type CanonicalHostrunEvalResult,
	type CanonicalHostrunProgressUpdate,
	type HostrunPiRequestHandler,
} from "./runner.ts";

export interface HostrunEvalParams {
	code: string;
	session_id?: string;
}

export interface HostrunPiCapabilitySnapshot {
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

export interface HostrunEvalContext {
	footerData?: ExtensionContext["footerData"];
	getContextUsage: ExtensionContext["getContextUsage"];
	model: ExtensionContext["model"];
	sessionManager: Pick<ExtensionContext["sessionManager"], "getCwd" | "getSessionName">;
}

export type HostrunPiRequestDispatcher = (
	request: { method: string; params: unknown },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
) => Promise<unknown> | unknown;

function formatResultValue(result: CanonicalHostrunEvalResult): string | undefined {
	if (result.type === "needs_approval") {
		return `needs approval: ${result.approval?.summary ?? "unknown Hostrun operation"}`;
	}
	if (result.value === undefined || result.value === null) {
		return undefined;
	}
	if (typeof result.value === "string") {
		return result.value.trim().length > 0 ? result.value : undefined;
	}
	return JSON.stringify(result.value);
}

function formatToolText(params: HostrunEvalParams, result: CanonicalHostrunEvalResult): string {
	const lines = [params.code, "", `Session: ${params.session_id ?? "default"}`];
	for (const entry of result.console ?? []) {
		lines.push(`${entry.level}: ${entry.message}`);
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

function formatProgressText(update: CanonicalHostrunProgressUpdate): string {
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

function createPiCapabilitySnapshot(ctx: HostrunEvalContext): HostrunPiCapabilitySnapshot {
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

export function createHostrunEvalExecutor(runner: HostrunRunnerClient, dispatchPiRequest?: HostrunPiRequestDispatcher) {
	return async (
		params: HostrunEvalParams,
		ctx: ExtensionContext,
		onUpdate?: (partialResult: AgentToolResult<CanonicalHostrunEvalResult | CanonicalHostrunProgressUpdate>) => void,
		signal?: AbortSignal,
	): Promise<AgentToolResult<CanonicalHostrunEvalResult>> => {
		const onPiRequest: HostrunPiRequestHandler = async (request) => {
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
