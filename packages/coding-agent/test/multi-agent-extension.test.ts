import { describe, expect, it } from "vitest";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { type AgentMailboxMessage, type AgentSnapshot, MultiAgentStore } from "../src/core/multi-agent-store.ts";
import multiAgentExtension from "../src/extensions/multi-agent.ts";

type RegisteredTool = Omit<ToolDefinition, "execute"> & {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Record<string, unknown>>>;
};

interface SpawnAgentDetails extends Record<string, unknown> {
	agent: AgentSnapshot;
	prompt: string;
}

interface ListAgentsDetails extends Record<string, unknown> {
	activeCount: number;
	agents: AgentSnapshot[];
}

interface WaitAgentDetails extends Record<string, unknown> {
	agent: AgentSnapshot;
	terminal: boolean;
}

interface CancelAgentDetails extends Record<string, unknown> {
	agent: AgentSnapshot;
	reason?: string;
}

interface SteerAgentDetails extends Record<string, unknown> {
	agent: AgentSnapshot;
	message: AgentMailboxMessage;
}

function createMultiAgentHarness() {
	const tools = new Map<string, RegisteredTool>();
	const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as unknown as ExtensionAPI;

	multiAgentExtension(pi, { store });

	const ctx = {
		cwd: "/repo",
		hasUI: false,
		mode: "print",
	} as ExtensionContext;

	return {
		call: async <TDetails extends Record<string, unknown>>(name: string, params: Record<string, unknown>) => {
			const tool = tools.get(name);
			if (!tool) {
				throw new Error(`tool not registered: ${name}`);
			}

			return (await tool.execute(`${name}-call`, params, undefined, undefined, ctx)) as AgentToolResult<TDetails>;
		},
		store,
		tools,
	};
}

describe("multi-agent extension tools", () => {
	it("registers spawn/list/wait/cancel/steer tools", () => {
		const harness = createMultiAgentHarness();

		expect([...harness.tools.keys()].sort()).toEqual([
			"cancel_agent",
			"list_agents",
			"spawn_agent",
			"steer_agent",
			"wait_agent",
		]);
	});

	it("spawns and lists store-backed agents without starting child model sessions", async () => {
		const harness = createMultiAgentHarness();

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			agentType: "scout",
			displayName: "Scout",
			prompt: "Inspect auth",
		});
		const listed = await harness.call<ListAgentsDetails>("list_agents", {});

		expect(spawned.details.agent).toMatchObject({
			agentType: "scout",
			cwd: "/repo",
			displayName: "Scout",
			lifecycle: "queued",
			parentId: undefined,
			revision: 1,
		});
		expect(spawned.details.prompt).toBe("Inspect auth");
		expect(harness.store.getActiveAgentCount()).toBe(1);
		expect(listed.details).toMatchObject({ activeCount: 1 });
		expect(listed.details.agents).toEqual([spawned.details.agent]);
	});

	it("waits and cancels through the core store", async () => {
		const harness = createMultiAgentHarness();
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "Implement tests",
		});
		const agent = spawned.details.agent;

		const waiting = await harness.call<WaitAgentDetails>("wait_agent", { agentId: agent.id });
		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: agent.id,
			expectedRevision: agent.revision,
			reason: "user stopped it",
		});

		expect(waiting.details).toMatchObject({ terminal: false, agent: { id: agent.id, lifecycle: "queued" } });
		expect(cancelled.details.agent).toMatchObject({
			id: agent.id,
			lifecycle: "aborted",
			revision: agent.revision + 1,
		});
		expect(cancelled.details.reason).toBe("user stopped it");
		expect(harness.store.getActiveAgentCount()).toBe(0);
	});

	it("steers a running agent with mailbox acknowledgement state", async () => {
		const harness = createMultiAgentHarness();
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Reviewer",
			lifecycle: "starting",
			prompt: "Review auth",
		});
		const agent = spawned.details.agent;
		const started = harness.store.transitionAgent(agent.id, agent.revision, "running");
		expect(started.ok).toBe(true);
		if (!started.ok) {
			throw new Error("expected running transition");
		}

		const steered = await harness.call<SteerAgentDetails>("steer_agent", {
			agentId: agent.id,
			expectedRevision: started.agent.revision,
			message: "Check permissions too",
			targetCheckpoint: "next_model_call",
		});

		expect(steered.details.agent).toMatchObject({ id: agent.id, lifecycle: "steering_pending" });
		expect(steered.details.message).toMatchObject({
			body: "Check permissions too",
			fromAgentId: "supervisor",
			kind: "steer",
			status: "pending",
			targetCheckpoint: "next_model_call",
			toAgentId: agent.id,
		});
	});
});
