import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { setAgentModel } from "../../extensions/agents-core/src/agent-model-tool.ts";
import { MultiAgentStore } from "../../src/core/multi-agent-store.ts";
import { legacyMultiAgentStore } from "../helpers/legacy-multi-agent-store.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

interface ObservedRequest {
	modelId: string;
	reasoning: string | undefined;
}

function spawnRunningChild(store: MultiAgentStore): string {
	return legacyMultiAgentStore(store).spawnAgent({
		agentType: "test",
		cwd: "/repo",
		displayName: "Child",
		permission: { narrowed: true, policy: "on-request" },
	}).agent.id;
}

function createGateTool(): { tool: AgentTool; started: Promise<void>; release: () => void } {
	let markStarted!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tool: AgentTool = {
		name: "gate",
		label: "Gate",
		description: "Blocks until the test releases it.",
		parameters: Type.Object({}),
		execute: async () => {
			markStarted();
			await released;
			return { content: [{ type: "text", text: "gate output" }], details: {} };
		},
	};
	return { tool, started, release };
}

async function createChildHarness(store: MultiAgentStore, agentId: string, tools: AgentTool[] = []) {
	const harness = await createHarness({
		models: [
			{ id: "faux-1", reasoning: true },
			{ id: "faux-2", reasoning: true },
			{ id: "plain", reasoning: false },
		],
		multiAgentAgentId: agentId,
		multiAgentStore: store,
		tools,
	});
	harnesses.push(harness);
	return harness;
}

describe("set_agent_model", () => {
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("switches a running child's model and effort from its next request without interrupting the current tool", async () => {
		const store = new MultiAgentStore({ now: () => "2026-10-08T12:00:00.000Z" });
		const agentId = spawnRunningChild(store);
		const gate = createGateTool();
		const harness = await createChildHarness(store, agentId, [gate.tool]);
		harness.session.setThinkingLevel("low");
		const defaultModelBefore = harness.settingsManager.getDefaultModel();
		const observed: ObservedRequest[] = [];
		const record = (modelId: string, options: unknown) =>
			observed.push({ modelId, reasoning: (options as { reasoning?: string } | undefined)?.reasoning });
		harness.setResponses([
			(_context, options, _state, model) => {
				record(model.id, options);
				return fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" });
			},
			(_context, options, _state, model) => {
				record(model.id, options);
				return fauxAssistantMessage("child done");
			},
		]);
		const sessions = new Map([[agentId, harness.session]]);

		const run = harness.session.prompt("work");
		await gate.started;
		const result = await setAgentModel(store, sessions, {
			agentId,
			provider: harness.getModel().provider,
			modelId: "faux-2",
			thinkingLevel: "high",
		});
		gate.release();
		await run;

		expect(observed).toEqual([
			{ modelId: "faux-1", reasoning: "low" },
			{ modelId: "faux-2", reasoning: "high" },
		]);
		expect(result.details).toMatchObject({ agentId, modelId: "faux-2", thinkingLevel: "high" });
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(JSON.stringify(toolResults[0])).toContain("gate output");
		expect(harness.settingsManager.getDefaultModel()).toBe(defaultModelBefore);
	});

	it("changes effort alone and clamps it to the model's capabilities", async () => {
		const store = new MultiAgentStore({ now: () => "2026-10-08T12:00:00.000Z" });
		const agentId = spawnRunningChild(store);
		const harness = await createChildHarness(store, agentId);
		const sessions = new Map([[agentId, harness.session]]);

		await setAgentModel(store, sessions, { agentId, thinkingLevel: "high" });
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.thinkingLevel).toBe("high");

		const result = await setAgentModel(store, sessions, {
			agentId,
			provider: harness.getModel().provider,
			modelId: "plain",
			thinkingLevel: "high",
		});
		expect(harness.session.model?.id).toBe("plain");
		expect(result.details.thinkingLevel).toBe("off");
	});

	it("rejects incomplete requests, unknown models, and agents without a live session", async () => {
		const store = new MultiAgentStore({ now: () => "2026-10-08T12:00:00.000Z" });
		const agentId = spawnRunningChild(store);
		const harness = await createChildHarness(store, agentId);
		const sessions = new Map([[agentId, harness.session]]);
		const provider = harness.getModel().provider;

		await expect(setAgentModel(store, sessions, { agentId })).rejects.toThrow("requires provider and modelId");
		await expect(setAgentModel(store, sessions, { agentId, modelId: "faux-2" })).rejects.toThrow(
			"requires both provider and modelId",
		);
		await expect(setAgentModel(store, sessions, { agentId, provider, modelId: "missing" })).rejects.toThrow(
			`Model not found: ${provider}/missing`,
		);
		await expect(setAgentModel(store, new Map(), { agentId, thinkingLevel: "low" })).rejects.toThrow(
			`Agent ${agentId} is not a live child session`,
		);
		await expect(setAgentModel(store, sessions, { agentId: "agent_missing", thinkingLevel: "low" })).rejects.toThrow(
			"Agent not found: agent_missing",
		);
		expect(harness.session.model?.id).toBe("faux-1");
	});
});
