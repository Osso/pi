import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { LifecycleCoordinator } from "../../src/core/lifecycle-coordinator.ts";
import { type AgentSnapshot, MultiAgentStore } from "../../src/core/multi-agent-store.ts";
import type { ProcessIdentity } from "../../src/core/runtime-process.ts";
import { getRuntimeProcessInstanceId, readMultiAgentState } from "../../src/core/session-control-db.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

async function createChild(
	options: { processIdentity?: ProcessIdentity; ownerSessionId?: string; tools?: AgentTool[] } = {},
) {
	const parent = await createHarness({
		persistedSession: true,
		fauxProvider: { provider: "metadata-parent" },
		settings: { defaultProvider: "metadata-parent", defaultModel: "parent-model", defaultThinkingLevel: "medium" },
	});
	harnesses.push(parent);
	const store = MultiAgentStore.fromSessionManager(parent.sessionManager);
	const persistence = store.getPersistenceTarget();
	if (!persistence) throw new Error("Expected persisted supervisor store");
	const agentId = "agent-effective-model";
	const child = await createHarness({
		persistedSession: true,
		fauxProvider: { provider: "metadata-child" },
		models: [
			{ id: "reasoning-one", reasoning: true },
			{ id: "reasoning-two", reasoning: true },
			{ id: "plain", reasoning: false },
		],
		settings: { defaultProvider: "parent-provider", defaultModel: "parent-model", defaultThinkingLevel: "medium" },
		tools: options.tools,
		multiAgentStore: store,
		multiAgentAgentId: agentId,
		multiAgentParentSessionId: parent.sessionManager.getSessionId(),
	});
	harnesses.push(child);
	const coordinator = new LifecycleCoordinator({
		...persistence,
		createAgentId: () => agentId,
		now: () => new Date().toISOString(),
		processIdentity: options.processIdentity ?? JSON.parse(getRuntimeProcessInstanceId()),
	});
	const prepared = coordinator.prepareChild({
		agentType: "test",
		cwd: child.tempDir,
		displayName: "Effective model child",
		permission: { narrowed: true, policy: "on-request" },
		model: { providerId: "stale-provider", modelId: "stale-model", thinkingLevel: "high" },
		transcript: { sessionId: child.sessionManager.getSessionId(), path: child.sessionManager.getSessionFile() },
	});
	const created = coordinator.commitRunningChild(
		prepared,
		options.ownerSessionId ?? parent.sessionManager.getSessionId(),
	);
	if (!created.ok) throw new Error(`Could not create child: ${created.error}`);
	store.publishLifecycleCoordinatorSnapshot(created.agent);
	const readChild = () =>
		(
			readMultiAgentState(persistence.controlDbPath, persistence.sessionPath)?.agents as AgentSnapshot[] | undefined
		)?.find((agent) => agent.id === agentId);
	return { parent, child, store, agentId, readChild, coordinator, ownership: created.ownership };
}

describe("child effective model metadata", () => {
	afterEach(() => {
		for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
	});

	it("replaces spawn metadata with the effective model when a child starts", async () => {
		const { child, store, agentId, readChild } = await createChild();
		child.setResponses([fauxAssistantMessage("started")]);
		await child.session.prompt("Start work");
		const model = { providerId: "metadata-child", modelId: "reasoning-one", thinkingLevel: "off" };
		expect(readChild()?.model).toEqual(model);
		expect(store.getAgent(agentId)?.model).toEqual(model);
		expect(readChild()).toMatchObject({ lifecycle: "running", revision: 1 });
	});

	it("publishes live effort, same-effort model switches, and capability clamping without changing defaults", async () => {
		let releaseTool!: () => void;
		let toolStarted!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const started = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const tool: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Keep child running during a model change",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted();
				await gate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const { parent, child, store, agentId, readChild } = await createChild({ tools: [tool] });
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
		]);
		const prompt = child.session.prompt("Work while model changes");
		await started;
		try {
			expect(child.session.isStreaming).toBe(true);
			const parentDefaults = parent.settingsManager.getMergedSettings();
			const childDefaults = child.settingsManager.getMergedSettings();
			const parentModel = parent.session.model;
			const parentThinking = parent.session.thinkingLevel;
			child.session.setThinkingLevel("high");
			expect(readChild()?.model).toEqual({
				providerId: "metadata-child",
				modelId: "reasoning-one",
				thinkingLevel: "high",
			});
			await child.session.setModel(child.getModel("reasoning-two")!);
			expect(readChild()?.model).toEqual({
				providerId: "metadata-child",
				modelId: "reasoning-two",
				thinkingLevel: "high",
			});
			await child.session.setModel(child.getModel("plain")!);
			expect(child.session.thinkingLevel).toBe("off");
			expect(readChild()?.model).toEqual({ providerId: "metadata-child", modelId: "plain", thinkingLevel: "off" });
			child.session.setThinkingLevel("xhigh");
			expect(store.getAgent(agentId)?.model).toEqual(readChild()?.model);
			expect(parent.settingsManager.getMergedSettings()).toEqual(parentDefaults);
			expect(child.settingsManager.getMergedSettings()).toEqual(childDefaults);
			expect(parent.session.model).toBe(parentModel);
			expect(parent.session.thinkingLevel).toBe(parentThinking);
			expect(readChild()).toMatchObject({ lifecycle: "running", revision: 1 });
		} finally {
			releaseTool();
			await prompt;
		}
	});

	it.each(["incarnation", "supervisor"])(
		"fails explicitly without overwriting metadata when the exact runtime %s differs",
		async (mismatch) => {
			const identity: ProcessIdentity = JSON.parse(getRuntimeProcessInstanceId());
			const { child, readChild } = await createChild(
				mismatch === "incarnation"
					? { processIdentity: { ...identity, incarnation: "different-child-runtime" } }
					: { ownerSessionId: "different-supervisor" },
			);
			const before = readChild();
			const modelBefore = child.session.model;
			const thinkingBefore = child.session.thinkingLevel;
			const persistedBefore = child.sessionManager.readPersistedSessionSettings();
			expect(() => child.session.setThinkingLevel("high")).toThrow(/metadata update was rejected/);
			expect(readChild()).toEqual(before);
			expect(child.session.thinkingLevel).toBe(thinkingBefore);
			await expect(child.session.setModel(child.getModel("reasoning-two")!)).rejects.toThrow(
				/metadata update was rejected/,
			);
			expect(readChild()).toEqual(before);
			expect(child.session.model).toBe(modelBefore);
			expect(child.session.thinkingLevel).toBe(thinkingBefore);
			expect(child.sessionManager.readPersistedSessionSettings()).toEqual(persistedBefore);
		},
	);
});
