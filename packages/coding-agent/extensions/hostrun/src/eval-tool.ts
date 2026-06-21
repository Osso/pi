import type { AgentToolResult } from "../../../src/core/extensions/types.ts";
import { HostrunSessionStore, type HostrunEvalResult } from "./session.ts";

export interface HostrunEvalParams {
	code: string;
	session_id?: string;
}

function formatResult(result: unknown): string {
	if (result === undefined) {
		return "undefined";
	}
	if (typeof result === "string") {
		return result;
	}
	return JSON.stringify(result);
}

function formatToolText(result: HostrunEvalResult): string {
	const lines = ["Executed code:", result.code, "", `Session: ${result.sessionId}`];
	if (result.error) {
		lines.push(`Error: ${result.error.name}: ${result.error.message}`);
	} else {
		lines.push(`Result: ${formatResult(result.result)}`);
	}
	return lines.join("\n");
}

export function createHostrunEvalExecutor(store: HostrunSessionStore) {
	return async (params: HostrunEvalParams): Promise<AgentToolResult<HostrunEvalResult>> => {
		const result = store.evaluate({ code: params.code, sessionId: params.session_id });
		return {
			content: [{ type: "text", text: formatToolText(result) }],
			details: result,
		};
	};
}
