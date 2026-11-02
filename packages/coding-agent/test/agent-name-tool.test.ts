import { describe, expect, it } from "vitest";
import { renameAgent } from "../extensions/agents-core/src/agent-name-tool.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";

const params = { agentId: "child", displayName: "New task name" };

function context(values: Partial<ExtensionContext>): ExtensionContext {
	return values as ExtensionContext;
}

describe("rename_agent authorization", () => {
	it.each([{ multiAgentAgentId: "child" }, { multiAgentRequiresAgentId: true }])(
		"rejects stale direct calls from a child runtime (%j)",
		(values) => {
			expect(() => renameAgent(params, context(values))).toThrow("rename_agent is controlled by the main thread");
		},
	);

	it("requires a multi-agent store in a main runtime", () => {
		expect(() => renameAgent(params, context({}))).toThrow("rename_agent requires a multi-agent store");
	});
});
