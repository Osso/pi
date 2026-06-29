import type { AgentToolResult, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	PyrunRunnerClient,
	type CanonicalPyrunEvalResult,
	type CanonicalPyrunProgressUpdate,
} from "./runner.ts";

export interface PyrunEvalParams {
	code: string;
	session_id?: string;
}

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

function formatToolText(params: PyrunEvalParams, result: CanonicalPyrunEvalResult): string {
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

function formatProgressText(update: CanonicalPyrunProgressUpdate): string {
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

export function createPyrunEvalExecutor(runner: PyrunRunnerClient) {
	return async (
		params: PyrunEvalParams,
		_ctx: ExtensionContext,
		onUpdate?: (partialResult: AgentToolResult<CanonicalPyrunEvalResult | CanonicalPyrunProgressUpdate>) => void,
		signal?: AbortSignal,
	): Promise<AgentToolResult<CanonicalPyrunEvalResult>> => {
		const result = await runner.evaluate(
			params,
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
			isError: result.error !== undefined,
		};
	};
}
