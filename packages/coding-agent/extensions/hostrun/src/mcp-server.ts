import type { AgentToolResult } from "../../../src/core/extensions/types.ts";
import { createHostrunEvalExecutor, type HostrunEvalContext, type HostrunEvalParams } from "./eval-tool.ts";
import { HostrunRunnerClient, type CanonicalHostrunEvalResult } from "./runner.ts";

export interface HostrunMcpTool {
	description: string;
	inputSchema: {
		properties: Record<string, unknown>;
		required: string[];
		type: "object";
	};
	name: "hostrun_eval";
}

export interface HostrunMcpServer {
	callTool(name: string, params: HostrunEvalParams): Promise<AgentToolResult<CanonicalHostrunEvalResult>>;
	tools: readonly HostrunMcpTool[];
	transport: "stdio";
}

const hostrunEvalTool: HostrunMcpTool = {
	description: "Evaluate JavaScript in a persistent Hostrun session.",
	inputSchema: {
		properties: {
			code: { type: "string" },
			session_id: { type: "string" },
		},
		required: ["code"],
		type: "object",
	},
	name: "hostrun_eval",
};

function createPendingApprovalContext(): HostrunEvalContext {
	return {
		hasUI: false,
		ui: {
			confirm: async () => false,
		},
	};
}

export function createHostrunMcpServer(): HostrunMcpServer {
	const runner = new HostrunRunnerClient();
	const evaluate = createHostrunEvalExecutor(runner);
	const context = createPendingApprovalContext();

	return {
		async callTool(name, params) {
			if (name !== "hostrun_eval") {
				throw new Error(`Unknown Hostrun MCP tool: ${name}`);
			}
			return evaluate(params, context);
		},
		tools: [hostrunEvalTool],
		transport: "stdio",
	};
}
