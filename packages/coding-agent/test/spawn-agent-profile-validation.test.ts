import { describe, expect, it, vi } from "vitest";
import { type ChildAgentSessionFactory, registerAgentsCoreTools } from "../extensions/agents-core/src/runtime.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type RegisteredTool = {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Record<string, unknown>>>;
	name: string;
};

function registerSpawnAgentTool(createChildSession: ChildAgentSessionFactory): RegisteredTool {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		appendEntry() {},
		on() {},
		registerCommand() {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as unknown as RegisteredTool);
		},
	} as unknown as ExtensionAPI;

	registerAgentsCoreTools(pi, { createChildSession });
	const tool = tools.get("spawn_agent");
	if (!tool) throw new Error("spawn_agent was not registered");
	return tool;
}

describe("spawn_agent profile validation", () => {
	it("rejects an explicit unconfigured agent type with configured-profile guidance", async () => {
		const createChildSession = vi.fn() as unknown as ChildAgentSessionFactory;
		const tool = registerSpawnAgentTool(createChildSession);
		const settingsManager = SettingsManager.inMemory({
			agents: {
				"fable-advisor": {
					model: "anthropic/claude-fable-5",
					thinkingLevel: "xhigh",
				},
			},
		});
		const ctx = { cwd: "/repo", settingsManager } as unknown as ExtensionContext;

		await expect(
			tool.execute(
				"spawn-call",
				{ agentType: "fable", context: "fresh", prompt: "Review the change" },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(
			'Unknown agent type "fable". Configured agent profiles: fable-advisor. Use one of these profile keys or omit agentType to inherit the parent model.',
		);

		expect(createChildSession).not.toHaveBeenCalled();
	});
});
