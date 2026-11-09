import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createChildTools } from "../../extensions/agents-core/src/child-tools.ts";
import { createEndDesignToolDefinition } from "../../extensions/agents-core/src/end-design-tool.ts";
import { MultiAgentStore } from "../../src/core/multi-agent-store.ts";
import { legacyMultiAgentStore } from "../helpers/legacy-multi-agent-store.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

function spawnRunningChild(store: MultiAgentStore, agentType: string) {
	return legacyMultiAgentStore(store).spawnAgent({
		agentType,
		cwd: "/repo",
		displayName: "Child",
		permission: { narrowed: true, policy: "on-request" },
	}).agent;
}

describe("end_design", () => {
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("is given only to children whose profile names an implementation profile", () => {
		const store = new MultiAgentStore({ now: () => "2026-11-09T12:00:00.000Z" });
		const designer = spawnRunningChild(store, "design-and-implement");
		const implementer = spawnRunningChild(store, "implement");

		expect(createChildTools(designer, undefined, "implement").map((tool) => tool.name)).toContain("end_design");
		expect(createChildTools(implementer, undefined, undefined).map((tool) => tool.name)).not.toContain("end_design");
	});

	it("switches the child to the implementation profile from its next request and refuses a second call", async () => {
		const store = new MultiAgentStore({ now: () => "2026-11-09T12:00:00.000Z" });
		const agentId = spawnRunningChild(store, "design-and-implement").id;
		const harness = await createHarness({
			fauxProvider: { provider: "faux-design" },
			models: [
				{ id: "designer", reasoning: true },
				{ id: "implementer", reasoning: true },
			],
			settings: { agents: { implement: { model: "faux-design/implementer", thinkingLevel: "low" } } },
			extensionFactories: [(pi) => pi.registerTool(createEndDesignToolDefinition("implement"))],
			multiAgentAgentId: agentId,
			multiAgentStore: store,
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("high");
		const observed: Array<{ modelId: string; reasoning: string | undefined }> = [];
		const record = (modelId: string, options: unknown) =>
			observed.push({ modelId, reasoning: (options as { reasoning?: string } | undefined)?.reasoning });
		harness.setResponses([
			(_context, options, _state, model) => {
				record(model.id, options);
				return fauxAssistantMessage(
					fauxToolCall("end_design", { handoff: "Credit only on the final boss kill." }),
					{
						stopReason: "toolUse",
					},
				);
			},
			(_context, options, _state, model) => {
				record(model.id, options);
				return fauxAssistantMessage(fauxToolCall("end_design", { handoff: "again" }), { stopReason: "toolUse" });
			},
			(_context, options, _state, model) => {
				record(model.id, options);
				return fauxAssistantMessage("implemented");
			},
		]);

		await harness.session.prompt("design then implement");

		expect(observed).toEqual([
			{ modelId: "designer", reasoning: "high" },
			{ modelId: "implementer", reasoning: "low" },
			{ modelId: "implementer", reasoning: "low" },
		]);
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults.map((message) => message.isError)).toEqual([false, true]);
		expect(JSON.stringify(toolResults[1])).toContain("Design already ended");
		expect(store.getAgent(agentId)?.model).toMatchObject({
			providerId: "faux-design",
			modelId: "implementer",
			thinkingLevel: "low",
		});
	});
});
