import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import type { MultiAgentProjectionSnapshot } from "../src/core/multi-agent-store.ts";
import { type AgentMailboxMessage, type AgentSnapshot, MultiAgentStore } from "../src/core/multi-agent-store.ts";
import type { CreateAgentSessionOptions } from "../src/core/sdk.ts";
import multiAgentExtension, {
	type ChildAgentDispatcher,
	type ChildAgentSessionFactory,
	createProductionChildAgentSessionFactory,
} from "../src/extensions/multi-agent.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./suite/harness.ts";

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
	dispatched: boolean;
	prompt: string;
}

interface ListAgentsDetails extends Record<string, unknown> {
	activeCount: number;
	agents: AgentSnapshot[];
}

interface WaitAgentDetails extends Record<string, unknown> {
	agent: AgentSnapshot;
	descendants?: AgentSnapshot[];
	pendingMessages?: AgentMailboxMessage[];
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

interface ContactSupervisorDetails extends Record<string, unknown> {
	agent: AgentSnapshot;
	message: AgentMailboxMessage;
}

interface AgentViewerDetails extends Record<string, unknown> {
	projection: MultiAgentProjectionSnapshot;
}

function createMultiAgentHarness(
	options: {
		createChildSession?: ChildAgentSessionFactory;
		ctx?: Partial<ExtensionContext>;
		dispatcher?: ChildAgentDispatcher;
	} = {},
) {
	const tools = new Map<string, RegisteredTool>();
	const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as unknown as ExtensionAPI;

	multiAgentExtension(pi, { createChildSession: options.createChildSession, dispatcher: options.dispatcher, store });

	const ctx = {
		cwd: "/repo",
		hasUI: false,
		mode: "print",
		...options.ctx,
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
	const childHarnesses: Harness[] = [];

	afterEach(() => {
		while (childHarnesses.length > 0) {
			childHarnesses.pop()?.cleanup();
		}
	});

	it("registers spawn/list/wait/cancel/steer/contact/viewer tools", () => {
		const harness = createMultiAgentHarness();

		expect([...harness.tools.keys()].sort()).toEqual([
			"agent_viewer",
			"cancel_agent",
			"contact_supervisor",
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

	it("lists descendants for a parent without TUI state", async () => {
		const harness = createMultiAgentHarness();
		const parent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Parent",
			prompt: "Parent task",
		});
		const child = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Child",
			parentId: parent.details.agent.id,
			prompt: "Child task",
		});
		await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Sibling",
			prompt: "Sibling task",
		});

		const listed = await harness.call<ListAgentsDetails>("list_agents", {
			parentId: parent.details.agent.id,
		});

		expect(listed.details).toMatchObject({ activeCount: 3 });
		expect(listed.details.agents.map((agent) => agent.id)).toEqual([child.details.agent.id]);
	});

	it("projects a read-only agent viewer snapshot without lifecycle mutation", async () => {
		const harness = createMultiAgentHarness();
		const parent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Parent",
			prompt: "Parent task",
		});
		const child = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Child",
			parentId: parent.details.agent.id,
			prompt: "Child task",
		});
		const pinned = harness.store.pinAgentSlot(child.details.agent.id, child.details.agent.revision, 3);
		expect(pinned.ok).toBe(true);
		if (!pinned.ok) {
			throw new Error("expected slot pin to succeed");
		}
		harness.store.selectAgentView(child.details.agent.id);

		const viewed = await harness.call<AgentViewerDetails>("agent_viewer", {});
		const afterView = harness.store.getAgent(child.details.agent.id);

		expect(viewed.details.projection).toMatchObject({
			activeCount: 2,
			selectedAgentId: child.details.agent.id,
			slots: [
				{
					agent: { id: child.details.agent.id, lifecycle: "queued", revision: pinned.agent.revision },
					agentId: child.details.agent.id,
					index: 3,
					pinned: true,
					revision: pinned.agent.revision,
				},
			],
		});
		expect(afterView).toMatchObject({
			id: child.details.agent.id,
			lifecycle: "queued",
			revision: pinned.agent.revision,
		});
	});

	it("lets a child contact its supervisor without choosing a sibling target", async () => {
		const harness = createMultiAgentHarness();
		const parent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Parent",
			prompt: "Parent task",
		});
		const child = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Child",
			parentId: parent.details.agent.id,
			prompt: "Child task",
		});
		await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Sibling",
			prompt: "Sibling task",
		});

		const contact = await harness.call<ContactSupervisorDetails>("contact_supervisor", {
			agentId: child.details.agent.id,
			artifactIds: ["artifact-1"],
			expectedRevision: child.details.agent.revision,
			message: "Need auth scope",
		});

		expect(contact.details.agent).toMatchObject({
			id: child.details.agent.id,
			lastActivity: { description: "Contacted supervisor" },
			revision: child.details.agent.revision + 1,
		});
		expect(contact.details.message).toMatchObject({
			artifactIds: ["artifact-1"],
			body: "Need auth scope",
			fromAgentId: child.details.agent.id,
			kind: "supervisor_request",
			status: "pending",
			toAgentId: parent.details.agent.id,
		});
	});

	it("passes mailbox artifact references by ID/path without copying content", async () => {
		const harness = createMultiAgentHarness();
		const parent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Parent",
			prompt: "Parent task",
		});
		const child = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Child",
			parentId: parent.details.agent.id,
			prompt: "Child task",
		});

		const contact = await harness.call<ContactSupervisorDetails>("contact_supervisor", {
			agentId: child.details.agent.id,
			artifactRefs: [
				{
					content: "large log content must not enter the mailbox",
					id: "log-1",
					label: "Tool log",
					path: "artifacts/tool.log",
				},
			],
			expectedRevision: child.details.agent.revision,
			message: "Review log",
		});

		expect(contact.details.message.artifactRefs).toEqual([
			{
				id: "log-1",
				label: "Tool log",
				path: "artifacts/tool.log",
			},
		]);
		expect(JSON.stringify(contact.details.message)).not.toContain("large log content");
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

	it("waits with descendant state and pending mailbox summaries without TUI state", async () => {
		const harness = createMultiAgentHarness();
		const parent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Parent",
			prompt: "Parent task",
		});
		const child = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Child",
			parentId: parent.details.agent.id,
			prompt: "Child task",
		});
		const contact = await harness.call<ContactSupervisorDetails>("contact_supervisor", {
			agentId: child.details.agent.id,
			expectedRevision: child.details.agent.revision,
			message: "Need review",
		});

		const waited = await harness.call<WaitAgentDetails>("wait_agent", {
			agentId: parent.details.agent.id,
			includeDescendants: true,
			includePendingMessages: true,
		});

		expect(waited.details).toMatchObject({
			agent: { id: parent.details.agent.id },
			descendants: [{ id: child.details.agent.id }],
			pendingMessages: [{ id: contact.details.message.id, toAgentId: parent.details.agent.id }],
			terminal: false,
		});
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

	it("dispatches a real child runner behind spawn_agent without TUI coupling", async () => {
		const dispatched: Array<{ agent: AgentSnapshot; prompt: string; mode: string; hasUI: boolean }> = [];
		const dispatcher: ChildAgentDispatcher = async ({ agent, ctx, prompt }) => {
			dispatched.push({ agent, hasUI: ctx.hasUI, mode: ctx.mode, prompt });
			return { lifecycle: "completed", result: { summary: "done" } };
		};
		const harness = createMultiAgentHarness({ dispatcher });

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			agentType: "worker",
			displayName: "Worker",
			prompt: "Implement auth tests",
		});
		const waited = await harness.call<WaitAgentDetails>("wait_agent", { agentId: spawned.details.agent.id });

		expect(dispatched).toEqual([
			{
				agent: expect.objectContaining({
					agentType: "worker",
					displayName: "Worker",
					lifecycle: "running",
				}) as AgentSnapshot,
				hasUI: false,
				mode: "print",
				prompt: "Implement auth tests",
			},
		]);
		expect(spawned.details).toMatchObject({
			dispatched: true,
			agent: { lifecycle: "completed", result: { summary: "done" } },
		});
		expect(waited.details).toMatchObject({
			agent: { id: spawned.details.agent.id, lifecycle: "completed" },
			terminal: true,
		});
	});

	it("dispatches a real child AgentSession behind spawn_agent", async () => {
		let childHarness: Harness | undefined;
		const harness = createMultiAgentHarness({
			createChildSession: async () => {
				childHarness = await createHarness();
				childHarnesses.push(childHarness);
				childHarness.setResponses([fauxAssistantMessage("child done")]);
				return childHarness.session;
			},
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			agentType: "worker",
			displayName: "Worker",
			prompt: "Implement auth tests",
		});
		const waited = await harness.call<WaitAgentDetails>("wait_agent", { agentId: spawned.details.agent.id });

		expect(childHarness).toBeDefined();
		if (!childHarness) {
			throw new Error("expected child harness");
		}
		expect(getUserTexts(childHarness)).toEqual(["Implement auth tests"]);
		expect(getAssistantTexts(childHarness)).toEqual(["child done"]);
		expect(spawned.details).toMatchObject({
			dispatched: true,
			agent: { lifecycle: "completed", result: { summary: "child done" } },
		});
		expect(waited.details).toMatchObject({
			agent: { id: spawned.details.agent.id, lifecycle: "completed" },
			terminal: true,
		});
	});

	it("wires spawn_agent to a production child AgentSession factory with parent session metadata", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		let childHarness: Harness | undefined;
		let sessionOptions: CreateAgentSessionOptions | undefined;
		const childSessionDir = `${parentHarness.tempDir}/child-sessions`;
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				sessionDir: childSessionDir,
				createSession: async (options) => {
					sessionOptions = options;
					childHarness = await createHarness();
					childHarnesses.push(childHarness);
					childHarness.setResponses([fauxAssistantMessage("factory child done")]);
					return { session: childHarness.session };
				},
			}),
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			agentType: "worker",
			displayName: "Worker",
			prompt: "Implement auth tests",
		});

		expect(sessionOptions).toMatchObject({
			cwd: "/repo",
			model: parentHarness.getModel(),
			modelRegistry: parentHarness.session.modelRegistry,
		});
		expect(sessionOptions?.sessionManager?.getHeader()).toMatchObject({
			cwd: "/repo",
			parentSession: parentHarness.sessionManager.getSessionId(),
		});
		expect(sessionOptions?.sessionManager?.getSessionDir()).toBe(childSessionDir);
		expect(childHarness).toBeDefined();
		if (!childHarness) {
			throw new Error("expected child harness");
		}
		expect(getUserTexts(childHarness)).toEqual(["Implement auth tests"]);
		expect(getAssistantTexts(childHarness)).toEqual(["factory child done"]);
		expect(spawned.details).toMatchObject({
			dispatched: true,
			agent: { lifecycle: "completed", result: { summary: "factory child done" } },
		});
	});
});
