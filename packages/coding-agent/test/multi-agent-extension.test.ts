import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import agentViewerExtension from "../extensions/agent-viewer/src/index.ts";
import agentsCoreExtension from "../extensions/agents-core/src/index.ts";
import { createHostrunMultiAgentRequestHandler } from "../extensions/agents-core/src/runtime.ts";
import agentsMailboxExtension from "../extensions/agents-mailbox/src/index.ts";
import goalExtension from "../extensions/goal/src/index.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ExtensionUIContext,
	RegisteredCommand,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import type { AgentArtifact, MultiAgentProjectionSnapshot } from "../src/core/multi-agent-store.ts";
import { type AgentMailboxMessage, type AgentSnapshot, MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import multiAgentExtension, {
	type ChildAgentDispatcher,
	type ChildAgentSessionFactory,
	createMultiAgentWorkflowOperations,
	createProductionChildAgentSessionFactory,
} from "../src/extensions/multi-agent.ts";
import { main } from "../src/main.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./suite/harness.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolvesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return Promise.race([promise.then(() => true), delay(ms).then(() => false)]);
}

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
	commands: Array<{ agentId: string; command: "stop" | "resume" | "steer"; tool: string }>;
	projection: MultiAgentProjectionSnapshot;
	statuses: Array<{ agentId: string; lifecycle: string; revision: number; terminal: boolean }>;
	transcripts: Array<{ agentId: string; path?: string; sessionId: string }>;
	tree: Array<{ agentId: string; children: string[]; parentId?: string }>;
}

interface AgentsMailboxDetails extends Record<string, unknown> {
	acknowledgements: AgentMailboxMessage[];
	inbox: AgentMailboxMessage[];
	outbox: AgentMailboxMessage[];
	pendingCount: number;
}

interface SendAgentMessageDetails extends Record<string, unknown> {
	agent: AgentSnapshot;
	message: AgentMailboxMessage;
}

interface AgentArtifactsDetails extends Record<string, unknown> {
	artifact?: AgentArtifact;
	artifacts?: AgentArtifact[];
}

type TestCommandContext = Omit<Partial<ExtensionCommandContext>, "ui"> & {
	ui?: Partial<ExtensionUIContext>;
};

type TtyTarget = typeof process.stdin | typeof process.stdout;

const commandSourceInfo = {
	origin: "top-level",
	path: "test",
	scope: "temporary",
	source: "extension",
} as const;

function createMultiAgentHarness(
	options: {
		createChildSession?: ChildAgentSessionFactory;
		ctx?: Partial<ExtensionContext>;
		dispatcher?: ChildAgentDispatcher;
		store?: MultiAgentStore;
	} = {},
) {
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, RegisteredTool>();
	const store = options.store ?? new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
	const pi = {
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, { ...command, name, sourceInfo: commandSourceInfo });
		},
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
		command: async (name: string, args: string, commandCtx: TestCommandContext = {}) => {
			const command = commands.get(name);
			if (!command) {
				throw new Error(`command not registered: ${name}`);
			}

			await command.handler(args, {
				...commandCtx,
				cwd: "/repo",
				hasUI: true,
				mode: "tui",
				ui: { notify: () => {}, setEditorText: () => {}, ...commandCtx.ui },
			} as ExtensionCommandContext);
		},
		commands,
		store,
		tools,
	};
}

async function waitForTerminalAgent(
	harness: ReturnType<typeof createMultiAgentHarness>,
	agentId: string,
): Promise<AgentToolResult<WaitAgentDetails>> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const waited = await harness.call<WaitAgentDetails>("wait_agent", { agentId });
		if (waited.details.terminal) {
			return waited;
		}
		await delay(1);
	}

	throw new Error(`agent did not reach terminal state: ${agentId}`);
}

function createSplitMultiAgentHarness() {
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, RegisteredTool>();
	const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
	const pi = {
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, { ...command, name, sourceInfo: commandSourceInfo });
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as unknown as ExtensionAPI;

	agentsCoreExtension(pi, { store });
	agentViewerExtension(pi, { store });
	agentsMailboxExtension(pi, { store });

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
		commands,
		store,
		tools,
	};
}

function collectTools(register: (pi: ExtensionAPI) => void): string[] {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerCommand() {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as unknown as ExtensionAPI;

	register(pi);

	return [...tools.keys()].sort();
}

function deferred<T>() {
	let resolve: (value: T | PromiseLike<T>) => void = () => {};
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function setIsTty(target: TtyTarget, value: boolean): PropertyDescriptor | undefined {
	const original = Object.getOwnPropertyDescriptor(target, "isTTY");
	Object.defineProperty(target, "isTTY", { configurable: true, value });
	return original;
}

function restoreIsTty(target: TtyTarget, original: PropertyDescriptor | undefined): void {
	if (original) {
		Object.defineProperty(target, "isTTY", original);
		return;
	}
	Reflect.deleteProperty(target, "isTTY");
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
			"agent_artifacts",
			"agent_viewer",
			"agents_mailbox",
			"cancel_agent",
			"contact_supervisor",
			"list_agents",
			"send_agent_message",
			"spawn_agent",
			"steer_agent",
			"wait_agent",
		]);
	});

	it("does not route multi-agent orchestration tools through generic approval", () => {
		const harness = createMultiAgentHarness();

		expect([...harness.tools.values()].map((tool) => [tool.name, tool.approvalRequired]).sort()).toEqual([
			["agent_artifacts", false],
			["agent_viewer", false],
			["agents_mailbox", false],
			["cancel_agent", false],
			["contact_supervisor", false],
			["list_agents", false],
			["send_agent_message", false],
			["spawn_agent", false],
			["steer_agent", false],
			["wait_agent", false],
		]);
	});

	it("registers split first-party modules over one shared multi-agent store", async () => {
		const harness = createSplitMultiAgentHarness();

		expect([...harness.tools.keys()].sort()).toEqual([
			"agent_artifacts",
			"agent_viewer",
			"agents_mailbox",
			"cancel_agent",
			"contact_supervisor",
			"list_agents",
			"send_agent_message",
			"spawn_agent",
			"steer_agent",
			"wait_agent",
		]);

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Split Worker",
			prompt: "Use shared store",
		});
		const viewed = await harness.call<AgentViewerDetails>("agent_viewer", {});
		const mailbox = await harness.call<AgentsMailboxDetails>("agents_mailbox", {
			agentId: spawned.details.agent.id,
		});

		expect(viewed.details.projection.agents.map((agent) => agent.id)).toEqual([spawned.details.agent.id]);
		expect(mailbox.details.pendingCount).toBe(0);
		expect(harness.store.getAgent(spawned.details.agent.id)).toMatchObject({
			displayName: "Split Worker",
		});
	});

	it("keeps split first-party modules scoped to core, viewer, and mailbox tools", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });

		expect(collectTools((pi) => agentsCoreExtension(pi, { store }))).toEqual([
			"agent_artifacts",
			"cancel_agent",
			"list_agents",
			"spawn_agent",
			"steer_agent",
			"wait_agent",
		]);
		expect(collectTools((pi) => agentViewerExtension(pi, { store }))).toEqual(["agent_viewer"]);
		expect(collectTools((pi) => agentsMailboxExtension(pi, { store }))).toEqual([
			"agents_mailbox",
			"contact_supervisor",
			"send_agent_message",
		]);
	});

	it("registers background job commands on the core module", () => {
		const harness = createSplitMultiAgentHarness();

		expect([...harness.commands.keys()].sort()).toEqual(["bg", "jobs"]);
	});

	it("runs /bg prompts as child jobs without waiting for completion", async () => {
		const childPrompt = deferred<void>();
		const createChildSession: ChildAgentSessionFactory = async () => ({
			messages: [],
			prompt: async () => childPrompt.promise,
		});
		const notifications: Array<{ message: string; level?: string }> = [];
		const harness = createMultiAgentHarness({ createChildSession });

		await harness.command("bg", "sleep 100", {
			ui: {
				notify: (message, level) => {
					notifications.push({ level, message });
				},
			},
		});

		const [agent] = harness.store.listAgents();
		expect(agent).toMatchObject({
			displayName: "Background Job",
			lifecycle: "running",
		});
		expect(notifications[0]?.message).toContain(agent.id);

		childPrompt.resolve();
		await harness.call<WaitAgentDetails>("wait_agent", { agentId: agent.id });
		expect(harness.store.getAgent(agent.id)).toMatchObject({ lifecycle: "completed" });
	});

	it("aborts a running /bg child session when the job is cancelled", async () => {
		const abort = vi.fn();
		const childPrompt = deferred<void>();
		const createChildSession: ChildAgentSessionFactory = async () => ({
			abort,
			messages: [],
			prompt: async () => childPrompt.promise,
		});
		const harness = createMultiAgentHarness({ createChildSession });

		await harness.command("bg", "sleep 100");
		await Promise.resolve();
		const [agent] = harness.store.listAgents();
		await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: agent.id,
			expectedRevision: agent.revision,
			reason: "user requested",
		});

		expect(abort).toHaveBeenCalledTimes(1);
		expect(harness.store.getAgent(agent.id)).toMatchObject({ lifecycle: "aborted" });
	});

	it("aborts a running spawn_agent child session when the agent is cancelled", async () => {
		const abort = vi.fn();
		const childPrompt = deferred<void>();
		const createChildSession: ChildAgentSessionFactory = async () => ({
			abort,
			messages: [],
			prompt: async () => childPrompt.promise,
		});
		const harness = createMultiAgentHarness({ createChildSession });

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "sleep 100",
		});
		await Promise.resolve();
		const current = harness.store.getAgent(spawned.details.agent.id);
		if (!current) {
			throw new Error("expected spawned agent");
		}
		await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: current.id,
			expectedRevision: current.revision,
			reason: "user requested",
		});

		expect(abort).toHaveBeenCalledTimes(1);
		expect(harness.store.getAgent(current.id)).toMatchObject({ lifecycle: "aborted" });
	});

	it("routes Hostrun agents.select through the interactive view callback when available", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
		});
		const selectAgentView = vi.fn((agentId: string) => store.selectActiveAgentTarget(agentId) !== undefined);
		const handler = createHostrunMultiAgentRequestHandler({ selectAgentView, store });
		const ctx = { cwd: "/repo", hasUI: false, mode: "print" } as ExtensionContext;

		const result = await handler({ method: "agents.select", params: { agentId: spawned.agent.id } }, ctx, undefined);

		expect(selectAgentView).toHaveBeenCalledWith(spawned.agent.id);
		expect(result).toMatchObject({ agent: { id: spawned.agent.id, displayName: "Worker" } });
	});

	it("rejects Hostrun agents.select when the interactive view callback fails", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const handler = createHostrunMultiAgentRequestHandler({ selectAgentView: () => false, store });
		const ctx = { cwd: "/repo", hasUI: false, mode: "print" } as ExtensionContext;

		await expect(
			handler({ method: "agents.select", params: { agentId: "agent_1" } }, ctx, undefined),
		).rejects.toThrow("Agent view selection failed: agent_1");
	});

	it("rejects Hostrun agents.wait requests without an agent id", async () => {
		const handler = createHostrunMultiAgentRequestHandler({ store: new MultiAgentStore() });
		const ctx = { cwd: "/repo", hasUI: false, mode: "print" } as ExtensionContext;

		await expect(handler({ method: "agents.wait", params: {} }, ctx, undefined)).rejects.toThrow(
			"pi.agents.wait requires a non-empty agentId",
		);
	});

	it("keeps spawn_agent returned revision usable after child transcript metadata attaches", async () => {
		const childPrompt = deferred<void>();
		const createChildSession: ChildAgentSessionFactory = async () => ({
			messages: [],
			prompt: async () => childPrompt.promise,
			transcript: { path: "sessions/child.jsonl", sessionId: "child-session" },
		});
		const harness = createMultiAgentHarness({ createChildSession });

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "sleep 100",
		});
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if (harness.store.getAgent(spawned.details.agent.id)?.transcript) {
				break;
			}
			await delay(1);
		}
		expect(harness.store.getAgent(spawned.details.agent.id)?.transcript).toBeDefined();
		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: spawned.details.agent.id,
			expectedRevision: spawned.details.agent.revision,
			reason: "user requested",
		});

		expect(cancelled.details.agent).toMatchObject({
			id: spawned.details.agent.id,
			lifecycle: "aborted",
		});
	});

	it("does not abort a /bg child session when cancel uses a stale revision", async () => {
		const abort = vi.fn();
		const childPrompt = deferred<void>();
		const createChildSession: ChildAgentSessionFactory = async () => ({
			abort,
			messages: [],
			prompt: async () => childPrompt.promise,
		});
		const harness = createMultiAgentHarness({ createChildSession });

		await harness.command("bg", "sleep 100");
		await Promise.resolve();
		const [agent] = harness.store.listAgents();
		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: agent.id,
			expectedRevision: agent.revision - 1,
			reason: "stale",
		});

		expect(cancelled.details.agent).toMatchObject({ id: agent.id, revision: agent.revision });
		expect(abort).not.toHaveBeenCalled();
		expect(harness.store.getAgent(agent.id)).toMatchObject({ lifecycle: "running" });
	});

	it("lists only background jobs in /jobs", async () => {
		const notifications: string[] = [];
		const harness = createMultiAgentHarness();

		await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Scout",
			prompt: "Inspect auth",
		});
		await harness.command("jobs", "", {
			ui: {
				notify: (message) => {
					notifications.push(message);
				},
			},
		});

		expect(notifications).toEqual(["No background jobs."]);
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

	it("exposes read-only tree status transcript and command descriptors in agent_viewer", async () => {
		const harness = createMultiAgentHarness();
		const parent = harness.store.spawnAgent({
			agentType: "lead",
			cwd: "/repo",
			displayName: "Lead",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
		});
		const child = harness.store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: parent.agent.id,
			permission: { inheritedFrom: parent.agent.id, narrowed: true, policy: "on-request" },
			transcript: { path: "sessions/child.jsonl", sessionId: "child-session" },
		});
		const running = harness.store.transitionAgent(child.agent.id, child.agent.revision, "starting");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected child start");
		}

		const viewed = await harness.call<AgentViewerDetails>("agent_viewer", {});

		expect(viewed.details.tree).toEqual([
			{ agentId: parent.agent.id, children: [child.agent.id], parentId: "root" },
			{ agentId: child.agent.id, children: [], parentId: parent.agent.id },
		]);
		expect(viewed.details.statuses).toMatchObject([
			{ agentId: parent.agent.id, lifecycle: "queued", revision: parent.agent.revision, terminal: false },
			{ agentId: child.agent.id, lifecycle: "starting", revision: running.agent.revision, terminal: false },
		]);
		expect(viewed.details.transcripts).toEqual([
			{ agentId: child.agent.id, path: "sessions/child.jsonl", sessionId: "child-session" },
		]);
		expect(viewed.details.commands).toEqual(
			expect.arrayContaining([
				{ agentId: child.agent.id, command: "stop", tool: "cancel_agent" },
				{ agentId: child.agent.id, command: "resume", tool: "wait_agent" },
				{ agentId: child.agent.id, command: "steer", tool: "steer_agent" },
			]),
		);
		expect(harness.store.getAgent(child.agent.id)).toMatchObject({
			id: child.agent.id,
			lifecycle: "starting",
			revision: running.agent.revision,
		});
	});

	it("projects mailbox inbox, outbox, and acknowledgements without mutating state", async () => {
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
		const started = harness.store.transitionAgent(child.details.agent.id, child.details.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) {
			throw new Error("expected starting transition");
		}
		const running = harness.store.transitionAgent(child.details.agent.id, started.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) {
			throw new Error("expected running transition");
		}
		const steered = await harness.call<SteerAgentDetails>("steer_agent", {
			agentId: child.details.agent.id,
			expectedRevision: running.agent.revision,
			message: "Check auth",
		});
		const accepted = harness.store.ackSteering(
			child.details.agent.id,
			steered.details.agent.revision,
			steered.details.message.id,
			"accepted",
		);
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) {
			throw new Error("expected steering acknowledgement");
		}
		const contact = await harness.call<ContactSupervisorDetails>("contact_supervisor", {
			agentId: child.details.agent.id,
			expectedRevision: accepted.agent.revision,
			message: "Need scope",
		});

		const childMailbox = await harness.call<AgentsMailboxDetails>("agents_mailbox", {
			agentId: child.details.agent.id,
		});
		const parentMailbox = await harness.call<AgentsMailboxDetails>("agents_mailbox", {
			agentId: parent.details.agent.id,
		});
		const childAfterMailbox = harness.store.getAgent(child.details.agent.id);

		expect(childMailbox.details).toMatchObject({
			acknowledgements: [{ id: steered.details.message.id, status: "accepted" }],
			inbox: [{ id: steered.details.message.id, fromAgentId: "supervisor", status: "accepted" }],
			outbox: [{ id: contact.details.message.id, toAgentId: parent.details.agent.id, status: "pending" }],
			pendingCount: 1,
		});
		expect(parentMailbox.details).toMatchObject({
			inbox: [{ id: contact.details.message.id, fromAgentId: child.details.agent.id, status: "pending" }],
			pendingCount: 1,
		});
		expect(childAfterMailbox).toMatchObject({
			id: child.details.agent.id,
			revision: contact.details.agent.revision,
		});
	});

	it("sends direct parent-child mailbox messages and rejects sibling targets", async () => {
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
		const sibling = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Sibling",
			prompt: "Sibling task",
		});

		const sent = await harness.call<SendAgentMessageDetails>("send_agent_message", {
			expectedRevision: parent.details.agent.revision,
			fromAgentId: parent.details.agent.id,
			message: "Please inspect auth",
			toAgentId: child.details.agent.id,
		});
		const rejected = await harness.call<SendAgentMessageDetails>("send_agent_message", {
			expectedRevision: child.details.agent.revision,
			fromAgentId: child.details.agent.id,
			message: "Can I read your state?",
			toAgentId: sibling.details.agent.id,
		});
		const childMailbox = await harness.call<AgentsMailboxDetails>("agents_mailbox", {
			agentId: child.details.agent.id,
		});

		expect(sent.details.message).toMatchObject({
			body: "Please inspect auth",
			fromAgentId: parent.details.agent.id,
			kind: "message",
			status: "pending",
			toAgentId: child.details.agent.id,
		});
		expect(childMailbox.details.inbox).toMatchObject([{ id: sent.details.message.id }]);
		expect(rejected.details).toMatchObject({
			agent: { id: child.details.agent.id, revision: child.details.agent.revision },
			message: { status: "failed", toAgentId: sibling.details.agent.id },
		});
	});

	it("records and lists shared artifacts outside mailbox events", async () => {
		const harness = createMultiAgentHarness();
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "Run tests",
		});

		const recorded = await harness.call<AgentArtifactsDetails>("agent_artifacts", {
			agentId: spawned.details.agent.id,
			inlinePreview: "First five log lines",
			kind: "log",
			metadata: { exitCode: 1 },
			path: "artifacts/tests.log",
			title: "Test log",
		});
		await harness.call<ContactSupervisorDetails>("contact_supervisor", {
			agentId: spawned.details.agent.id,
			artifactRefs: [
				{
					id: recorded.details.artifact?.id,
					label: recorded.details.artifact?.title,
					path: recorded.details.artifact?.path,
				},
			],
			expectedRevision: spawned.details.agent.revision,
			message: "Review log",
		});
		const listed = await harness.call<AgentArtifactsDetails>("agent_artifacts", {
			agentId: spawned.details.agent.id,
		});

		expect(recorded.details.artifact).toMatchObject({
			agentId: spawned.details.agent.id,
			inlinePreview: "First five log lines",
			kind: "log",
			path: "artifacts/tests.log",
			title: "Test log",
		});
		expect(listed.details.artifacts).toEqual([recorded.details.artifact]);
		expect(JSON.stringify(harness.store.listMailboxMessages())).not.toContain("First five log lines");
	});

	it("exposes workflow operations that compose spawn, message, wait, and artifacts through core state", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const workflow = createMultiAgentWorkflowOperations(store);

		const parent = workflow.spawnAgent({
			agentType: "lead",
			cwd: "/repo",
			displayName: "Lead",
			permission: { narrowed: true, policy: "on-request" },
		});
		const child = workflow.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: parent.agent.id,
			permission: { narrowed: true, policy: "on-request" },
		});
		const artifact = workflow.recordArtifact({
			agentId: child.agent.id,
			kind: "finding",
			title: "Auth finding",
		});
		const message = workflow.sendAgentMessage(parent.agent.id, parent.agent.revision, {
			artifactRefs: [{ id: artifact.id, label: artifact.title }],
			body: "Review finding",
			toAgentId: child.agent.id,
		});
		const waited = workflow.waitAgent(parent.agent.id, {
			includeDescendants: true,
			includePendingMessages: true,
		});

		expect(message.ok).toBe(true);
		expect(waited).toMatchObject({
			agent: { id: parent.agent.id },
			descendants: [{ id: child.agent.id }],
			pendingMessages: [],
			terminal: false,
		});
		expect(store.listMailboxMessages()).toHaveLength(1);
		expect(store.listArtifacts()).toEqual([artifact]);
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

	it("returns from spawn_agent before the background dispatcher settles", async () => {
		const dispatchGate = deferred<void>();
		const dispatcher: ChildAgentDispatcher = async () => {
			await dispatchGate.promise;
			return { lifecycle: "completed", result: { summary: "done" } };
		};
		const harness = createMultiAgentHarness({ dispatcher });

		const spawnPromise = harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "Implement auth tests",
		});
		const didResolveBeforeDispatch = await resolvesWithin(spawnPromise, 20);
		dispatchGate.resolve(undefined);
		const spawned = await spawnPromise;

		expect(didResolveBeforeDispatch).toBe(true);
		expect(spawned.details).toMatchObject({ dispatched: true });
	});

	it("wait_agent waits for a dispatched agent to reach a terminal state", async () => {
		const dispatchGate = deferred<void>();
		const dispatcher: ChildAgentDispatcher = async () => {
			await dispatchGate.promise;
			return { lifecycle: "completed", result: { summary: "done" } };
		};
		const harness = createMultiAgentHarness({ dispatcher });
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "Implement auth tests",
		});

		const waitPromise = harness.call<WaitAgentDetails>("wait_agent", { agentId: spawned.details.agent.id });
		const didResolveBeforeDispatch = await resolvesWithin(waitPromise, 20);
		dispatchGate.resolve(undefined);
		const waited = await waitPromise;

		expect(didResolveBeforeDispatch).toBe(false);
		expect(waited.details).toMatchObject({
			agent: { id: spawned.details.agent.id, lifecycle: "completed" },
			terminal: true,
		});
	});

	it("wait_agent returns terminal store state even when a tracked dispatch is still settling", async () => {
		const dispatchGate = deferred<void>();
		const terminalGate = deferred<void>();
		const terminalState = deferred<void>();
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const dispatcher: ChildAgentDispatcher = async ({ agent }) => {
			await terminalGate.promise;
			store.transitionAgent(agent.id, agent.revision, "completed", { result: { summary: "done" } });
			terminalState.resolve(undefined);
			await dispatchGate.promise;
			return { lifecycle: "completed", result: { summary: "late" } };
		};
		const harness = createMultiAgentHarness({ dispatcher, store });
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "Implement auth tests",
		});

		const waitPromise = harness.call<WaitAgentDetails>("wait_agent", { agentId: spawned.details.agent.id });
		const didResolveBeforeTerminal = await resolvesWithin(waitPromise, 20);
		terminalGate.resolve(undefined);
		await terminalState.promise;
		const didResolveAfterTerminal = await resolvesWithin(waitPromise, 100);
		dispatchGate.resolve(undefined);
		const waited = await waitPromise;

		expect(didResolveBeforeTerminal).toBe(false);
		expect(didResolveAfterTerminal).toBe(true);
		expect(waited.details).toMatchObject({
			agent: { id: spawned.details.agent.id, lifecycle: "completed", result: { summary: "done" } },
			terminal: true,
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
		const waited = await waitForTerminalAgent(harness, spawned.details.agent.id);

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
		});
		expect(waited.details).toMatchObject({
			agent: { id: spawned.details.agent.id, lifecycle: "completed" },
			terminal: true,
		});
	});

	it("includes a completed agent summary in wait_agent output", async () => {
		const dispatcher: ChildAgentDispatcher = async () => ({
			lifecycle: "completed",
			result: { summary: "Committed 18125d44 feat: add local deploy script" },
		});
		const harness = createMultiAgentHarness({ dispatcher });

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "commit workflow",
			prompt: "Commit current changes",
		});
		const waited = await harness.call<WaitAgentDetails>("wait_agent", { agentId: spawned.details.agent.id });

		expect(waited.content).toEqual([
			{
				type: "text",
				text: "commit workflow is completed: Committed 18125d44 feat: add local deploy script",
			},
		]);
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
		const waited = await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(childHarness).toBeDefined();
		if (!childHarness) {
			throw new Error("expected child harness");
		}
		expect(getUserTexts(childHarness)).toEqual(["Implement auth tests"]);
		expect(getAssistantTexts(childHarness)).toEqual(["child done"]);
		expect(spawned.details).toMatchObject({
			dispatched: true,
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
				createSessionManager: SessionManager.create,
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
		const waited = await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(sessionOptions).toMatchObject({
			cwd: "/repo",
			excludeTools: ["spawn_agent"],
			model: parentHarness.getModel(),
			modelRegistry: parentHarness.session.modelRegistry,
		});
		expect(sessionOptions?.sessionManager?.getHeader()).toMatchObject({
			cwd: "/repo",
			parentSession: parentHarness.sessionManager.getSessionId(),
		});
		expect(sessionOptions?.sessionManager?.getSessionDir()).toBe(childSessionDir);
		expect(sessionOptions?.sessionStartEvent).toEqual({ type: "session_start", reason: "fork" });

		expect(childHarness).toBeDefined();
		if (!childHarness) {
			throw new Error("expected child harness");
		}
		expect(getUserTexts(childHarness)).toEqual(["Implement auth tests"]);
		expect(getAssistantTexts(childHarness)).toEqual(["factory child done"]);
		expect(spawned.details).toMatchObject({
			dispatched: true,
		});
		expect(waited.details).toMatchObject({
			agent: { id: spawned.details.agent.id, lifecycle: "completed", result: { summary: "factory child done" } },
			terminal: true,
		});
	});

	it("propagates custom main extension factories into production child sessions", async () => {
		const tempDir = join(tmpdir(), `pi-main-child-factories-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		const originalCwd = process.cwd();
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		const originalStdinIsTty = setIsTty(process.stdin, true);
		const originalStdoutIsTty = setIsTty(process.stdout, true);
		const faux = registerFauxProvider();
		const model = faux.getModel();
		let customExtensionLoads = 0;
		const customExtension: ExtensionFactory = (pi) => {
			customExtensionLoads += 1;
			pi.registerProvider(model.provider, {
				api: faux.api,
				apiKey: "faux-key",
				baseUrl: model.baseUrl,
				models: faux.models.map((registeredModel) => ({
					api: registeredModel.api,
					baseUrl: registeredModel.baseUrl,
					contextWindow: registeredModel.contextWindow,
					cost: registeredModel.cost,
					id: registeredModel.id,
					input: registeredModel.input,
					maxTokens: registeredModel.maxTokens,
					name: registeredModel.name,
					reasoning: registeredModel.reasoning,
				})),
			});
		};
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("spawn_agent", { displayName: "Child", prompt: "child prompt" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("child done"),
			fauxAssistantMessage("parent done"),
		]);

		try {
			process.env[ENV_AGENT_DIR] = agentDir;
			process.chdir(projectDir);
			await main(["-p", "spawn a child", "--model", `${model.provider}/${model.id}`], {
				extensionFactories: [customExtension],
			});
			for (let attempt = 0; attempt < 50 && customExtensionLoads < 2; attempt += 1) {
				await delay(1);
			}

			expect(customExtensionLoads).toBe(2);
		} finally {
			faux.unregister();
			restoreIsTty(process.stdin, originalStdinIsTty);
			restoreIsTty(process.stdout, originalStdoutIsTty);
			process.chdir(originalCwd);
			if (originalAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = originalAgentDir;
			}
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("records production child transcript metadata when the child session is created", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-child-transcript-"));
		try {
			const parentSessionManager = SessionManager.create("/repo", tmp);
			const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			const harness = createMultiAgentHarness({
				ctx: { sessionManager: parentSessionManager },
				store,
				createChildSession: createProductionChildAgentSessionFactory({
					createSessionManager: SessionManager.create,
					createSession: async (options) => {
						const sessionManager = options.sessionManager;
						if (!sessionManager) {
							throw new Error("expected child session manager");
						}
						sessionManager.appendMessage({
							role: "user",
							content: "child prompt persisted",
							timestamp: 1,
						});
						sessionManager.appendMessage(fauxAssistantMessage("child response persisted"));
						return {
							session: {
								messages: [fauxAssistantMessage("child transcript ready")],
								prompt: async () => {},
							},
						};
					},
				}),
			});

			const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
				displayName: "Worker",
				prompt: "Work",
			});

			await waitForTerminalAgent(harness, spawned.details.agent.id);
			const agent = store.getAgent(spawned.details.agent.id);
			expect(agent?.transcript?.sessionId).toMatch(/^[0-9a-f-]+$/);
			expect(agent?.transcript?.path).toContain(tmp);
			expect(agent?.transcript?.path).toContain(agent?.transcript?.sessionId);
			expect(existsSync(agent?.transcript?.path ?? "")).toBe(true);
		} finally {
			rmSync(tmp, { force: true, recursive: true });
		}
	});

	it("loads goal tools into production child sessions without mutating the parent goal", async () => {
		const parentHarness = await createHarness({ extensionFactories: [goalExtension] });
		childHarnesses.push(parentHarness);
		parentHarness.sessionManager.setSessionGoalJson(
			JSON.stringify({ objective: "parent objective", branch: "test", createdAt: "2026-01-01T00:00:00.000Z" }),
		);
		parentHarness.setResponses([
			fauxAssistantMessage(fauxToolCall("set_goal", { objective: "child objective" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("child done"),
		]);
		let childSessionManager: SessionManager | undefined;
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				extensionFactories: [goalExtension],
				createSessionManager: SessionManager.create,
				createSession: async (options) => {
					const result = await createAgentSession({
						...options,
						authStorage: parentHarness.authStorage,
					});
					childSessionManager = result.session.sessionManager;
					return { session: result.session };
				},
			}),
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "Set your own goal",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		const parentGoal = JSON.parse(parentHarness.sessionManager.getSessionGoalJson() ?? "{}");
		const childGoal = JSON.parse(childSessionManager?.getSessionGoalJson() ?? "{}");
		expect(parentGoal.objective).toBe("parent objective");
		expect(childGoal.objective).toBe("child objective");
	});

	it("resolves agent profile child sessions from settings", async () => {
		const parentHarness = await createHarness({
			models: [
				{ id: "parent-model", reasoning: true },
				{ id: "explore-model", reasoning: true },
				{ id: "implement-model", reasoning: true },
			],
			settings: {
				agents: {
					explore: { model: "faux/explore-model", thinkingLevel: "low" },
					implement: { model: "faux/implement-model", thinkingLevel: "medium" },
				},
			},
		});
		childHarnesses.push(parentHarness);
		let sessionOptions: CreateAgentSessionOptions | undefined;
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel("parent-model"),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
				settingsManager: parentHarness.settingsManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				createSessionManager: SessionManager.create,
				createSession: async (options) => {
					sessionOptions = options;
					const childHarness = await createHarness();
					childHarnesses.push(childHarness);
					childHarness.setResponses([fauxAssistantMessage("explore child done")]);
					return { session: childHarness.session };
				},
			}),
		});

		const exploreAgent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			agentType: "explore",
			prompt: "Map the codebase",
		});
		await waitForTerminalAgent(harness, exploreAgent.details.agent.id);

		expect(sessionOptions?.model).toMatchObject({ provider: "faux", id: "explore-model" });
		expect(sessionOptions?.thinkingLevel).toBe("low");

		const implementAgent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			agentType: "implement",
			prompt: "Make the scoped change",
		});
		await waitForTerminalAgent(harness, implementAgent.details.agent.id);

		expect(sessionOptions?.model).toMatchObject({ provider: "faux", id: "implement-model" });
		expect(sessionOptions?.thinkingLevel).toBe("medium");
	});

	it("uses the parent session directory for production child sessions by default", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		let sessionOptions: CreateAgentSessionOptions | undefined;
		const parentSessionDir = `${parentHarness.tempDir}/parent-sessions`;
		const parentSessionManager = SessionManager.create("/repo", parentSessionDir);
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentSessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				createSessionManager: SessionManager.create,
				createSession: async (options) => {
					sessionOptions = options;
					const childHarness = await createHarness();
					childHarnesses.push(childHarness);
					childHarness.setResponses([fauxAssistantMessage("default dir child done")]);
					return { session: childHarness.session };
				},
			}),
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "Check default session dir",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(sessionOptions?.sessionManager?.getSessionDir()).toBe(parentSessionDir);
	});
});
