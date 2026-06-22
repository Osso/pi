import type { AgentToolResult } from "../../../src/core/extensions/types.ts";
import type { HostrunEvalParams } from "./eval-tool.ts";
import type { HostrunEvalResult } from "./session.ts";

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
	callTool(name: string, params: HostrunEvalParams): Promise<AgentToolResult<HostrunEvalResult>>;
	tools: readonly HostrunMcpTool[];
	transport: "stdio";
}

export function createHostrunMcpServer(): HostrunMcpServer {
	return {
		async callTool() {
			throw new Error("Hostrun MCP server is not implemented");
		},
		tools: [],
		transport: "stdio",
	};
}
