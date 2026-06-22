import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { HostrunRunnerClient, type CanonicalHostrunEvalResult } from "./runner.ts";

export interface HostrunEvalParams {
	code: string;
	session_id?: string;
}

export interface HostrunEvalContext {
	hasUI: boolean;
	ui: Pick<ExtensionContext["ui"], "confirm">;
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
	const lines = ["Executed code:", params.code, "", `Session: ${params.session_id ?? "default"}`];
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

export function createHostrunEvalExecutor(runner: HostrunRunnerClient) {
	return async (
		params: HostrunEvalParams,
		_ctx: HostrunEvalContext,
	): Promise<AgentToolResult<CanonicalHostrunEvalResult>> => {
		const result = await runner.evaluate(params);
		return {
			content: [{ type: "text", text: formatToolText(params, result) }],
			details: result,
		};
	};
}
