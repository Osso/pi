import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	HostrunRunnerClient,
	type CanonicalHostrunEvalResult,
	type CanonicalHostrunProgressUpdate,
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

function formatResultValue(result: CanonicalHostrunEvalResult): string {
	if (result.type === "needs_approval") {
		return `needs approval: ${result.approval?.summary ?? "unknown Hostrun operation"}`;
	}
	if (result.value === undefined) {
		return "undefined";
	}
	if (typeof result.value === "string") {
		return result.value;
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
		lines.push(`Result: ${formatResultValue(result)}`);
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

export function createHostrunEvalExecutor(runner: HostrunRunnerClient) {
	return async (
		params: HostrunEvalParams,
		ctx: HostrunEvalContext,
		onUpdate?: (partialResult: AgentToolResult<CanonicalHostrunEvalResult | CanonicalHostrunProgressUpdate>) => void,
		signal?: AbortSignal,
	): Promise<AgentToolResult<CanonicalHostrunEvalResult>> => {
		const result = await runner.evaluate(
			{ ...params, pi: createPiCapabilitySnapshot(ctx) },
			(update) => {
				onUpdate?.({
					content: [{ type: "text", text: formatProgressText(update) }],
					details: update,
				});
			},
			signal,
		);
		return {
			content: [{ type: "text", text: formatToolText(params, result) }],
			details: result,
		};
	};
}
