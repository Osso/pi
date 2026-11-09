import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "../../../src/core/extensions/types.ts";
import type { AgentSnapshot } from "../../../src/core/multi-agent-store.ts";
import { createAgentConfigReadToolDefinition } from "../../../src/core/tools/read.ts";
import { createSearchParentSessionHistoryToolDefinition } from "../../../src/core/tools/search-current-session-history.ts";
import { createChildEndTurnToolDefinition } from "./child-report.ts";
import { createEndDesignToolDefinition } from "./end-design-tool.ts";

const DEFAULT_BROWSER_AGENT_CONFIG_ROOT = join(homedir(), "AgentConfig");

/** Tools only spawned and attached child runtimes receive. */
export function createChildTools(
	agent: AgentSnapshot,
	browserAgentConfigRoot: string | undefined,
	implementAs: string | undefined,
): ToolDefinition[] {
	const tools: ToolDefinition[] = [
		defineTool(createChildEndTurnToolDefinition()),
		defineTool(createSearchParentSessionHistoryToolDefinition()),
	];
	if (agent.agentType === "browser") {
		const allowedRoot = browserAgentConfigRoot ?? DEFAULT_BROWSER_AGENT_CONFIG_ROOT;
		tools.push(createAgentConfigReadToolDefinition(agent.cwd, allowedRoot));
	}
	if (implementAs) tools.push(defineTool(createEndDesignToolDefinition(implementAs)));
	return tools;
}
