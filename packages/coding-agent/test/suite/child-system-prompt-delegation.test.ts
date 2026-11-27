import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { MultiAgentStore } from "../../src/core/multi-agent-store.ts";
import { legacyMultiAgentStore } from "../helpers/legacy-multi-agent-store.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

const spawnAgentTool: AgentTool = {
	name: "spawn_agent",
	label: "spawn_agent",
	description: "Spawn an agent",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
};

const MAIN_ONLY_AGENT_TYPES = ["implement", "verifier", "documentation-update", "reviewer"];

async function systemPromptFor(multiAgentAgentId?: string, store?: MultiAgentStore): Promise<string> {
	const harness = await createHarness({
		tools: [spawnAgentTool],
		initialActiveToolNames: ["spawn_agent"],
		multiAgentAgentId,
		multiAgentStore: store,
	});
	harnesses.push(harness);
	return harness.session.systemPrompt;
}

describe("spawn_agent delegation guidelines", () => {
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("tell a main session to delegate to implement, verifier, documentation-update, and reviewer agents", async () => {
		const prompt = await systemPromptFor();
		for (const agentType of MAIN_ONLY_AGENT_TYPES) expect(prompt).toContain(`agentType "${agentType}"`);
		expect(prompt).toContain('agentType "explore"');
	});

	it("tell a child agent only about explore consultations, the one spawn it may make", async () => {
		const store = new MultiAgentStore({ now: () => "2026-11-27T12:00:00.000Z" });
		const childId = legacyMultiAgentStore(store).spawnAgent({
			agentType: "implement",
			cwd: "/repo",
			displayName: "Child",
			permission: { narrowed: true, policy: "on-request" },
		}).agent.id;

		const prompt = await systemPromptFor(childId, store);

		for (const agentType of MAIN_ONLY_AGENT_TYPES) expect(prompt).not.toContain(`agentType "${agentType}"`);
		expect(prompt).not.toContain("still use a verifier");
		expect(prompt).toContain('agentType "explore"');
	});
});
