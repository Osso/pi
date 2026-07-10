import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import agentViewerExtension from "../extensions/agent-viewer/src/index.ts";
import agentsCoreExtension from "../extensions/agents-core/src/index.ts";
import {
	createHostrunMultiAgentRequestHandler,
	createMultiAgentRuntimeHandles,
} from "../extensions/agents-core/src/runtime.ts";
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
import type { AgentArtifact } from "../src/core/multi-agent-store.ts";
import {
	type AgentMailboxMessage,
	type AgentSnapshot,
	isActiveLifecycle,
	MultiAgentStore,
} from "../src/core/multi-agent-store.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import {
	ENV_SELF_RESTART_OLD_PID,
	ENV_SELF_RESTART_PROMPT,
	ENV_SELF_RESTART_SESSION,
} from "../src/core/self-restart.ts";
import {
	enqueueRuntimeMailboxMessage,
	getControlDbPath,
	listRuntimeMailboxMessages,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";
import multiAgentExtension, {
	type AttachedSessionFactory,
	type ChildAgentDispatcher,
	type ChildAgentSessionFactory,
	createMultiAgentWorkflowOperations,
	createProductionAttachedSessionFactory,
	createProductionChildAgentSessionFactory,
} from "../src/extensions/multi-agent.ts";
import { main } from "../src/main.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./suite/harness.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function completeAgent(store: MultiAgentStore, agent: AgentSnapshot): AgentSnapshot {
	const started = store.transitionAgent(agent.id, agent.revision, "starting");
	expect(started.ok).toBe(true);
	if (!started.ok) throw new Error("expected starting transition");
	const running = store.transitionAgent(agent.id, started.agent.revision, "running");
	expect(running.ok).toBe(true);
	if (!running.ok) throw new Error("expected running transition");
	const completed = store.transitionAgent(agent.id, running.agent.revision, "completed");
	expect(completed.ok).toBe(true);
	if (!completed.ok) throw new Error("expected completed transition");
	return completed.agent;
}

const managedTempDirs: string[] = [];

afterAll(() => {
	for (const dir of managedTempDirs) {
		rmSync(dir, { force: true, recursive: true });
	}
});

function createControlDbSession(cwd = "/repo"): SessionManager {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-ext-db-"));
	managedTempDirs.push(tempDir);
	const session = SessionManager.create(cwd, tempDir);
	session.setMetadataControlDbPath(getControlDbPath(tempDir));
	return session;
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

interface AttachSessionAgentDetails extends Record<string, unknown> {
	agent: AgentSnapshot;
	dispatched: boolean;
	prompt?: string;
}

interface ListAgentsDetails extends Record<string, unknown> {
	activeCount: number;
	agents: AgentSnapshot[];
}

interface WaitAgentsDetails extends Record<string, unknown> {
	message?: AgentMailboxMessage;
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
	agent: AgentSnapshot;
	children: string[];
	commands: Array<{ agentId: string; command: "stop" | "steer"; tool: string }>;
	parentId?: string;
	status: { agentId: string; lifecycle: string; revision: number; terminal: boolean };
	transcript?: { agentId: string; path?: string; sessionId: string };
}

interface MailboxDetails {
	acknowledgements: AgentMailboxMessage[];
	inbox: AgentMailboxMessage[];
	outbox: AgentMailboxMessage[];
	pendingCount: number;
}

function expectWaitCompletionMessage(result: AgentToolResult<Record<string, unknown>>, body: string): void {
	expect(result.content).toEqual([{ text: body, type: "text" }]);
	expect(result.details).toMatchObject({ message: { body, status: "delivered" } });
}

function mailboxDetails(store: MultiAgentStore, agentId?: string): MailboxDetails {
	const messages = store.listMailboxMessages();
	const scopedMessages = agentId
		? messages.filter((message) => message.toAgentId === agentId || message.fromAgentId === agentId)
		: messages;
	const inbox = agentId ? scopedMessages.filter((message) => message.toAgentId === agentId) : scopedMessages;
	const outbox = agentId ? scopedMessages.filter((message) => message.fromAgentId === agentId) : scopedMessages;

	return {
		acknowledgements: scopedMessages.filter((message) => message.status !== "pending"),
		inbox,
		outbox,
		pendingCount: scopedMessages.filter((message) => message.status === "pending").length,
	};
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
		createAttachedSession?: AttachedSessionFactory;
		createChildSession?: ChildAgentSessionFactory;
		ctx?: Partial<ExtensionContext>;
		dispatcher?: ChildAgentDispatcher;
		runtimeHandles?: ReturnType<typeof createMultiAgentRuntimeHandles>;
		store?: MultiAgentStore;
	} = {},
) {
	const commands = new Map<string, RegisteredCommand>();
	const eventHandlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void | Promise<void>>>();
	const tools = new Map<string, RegisteredTool>();
	const store = options.store ?? new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
	const pi = {
		on(eventName: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) {
			eventHandlers.set(eventName, [...(eventHandlers.get(eventName) ?? []), handler]);
		},
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, { ...command, name, sourceInfo: commandSourceInfo });
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as unknown as ExtensionAPI;

	multiAgentExtension(pi, {
		createAttachedSession: options.createAttachedSession,
		createChildSession: options.createChildSession,
		dispatcher: options.dispatcher,
		runtimeHandles: options.runtimeHandles,
		store,
	});

	const ctx = {
		cwd: "/repo",
		hasUI: false,
		mode: "print",
		...options.ctx,
	} as ExtensionContext;

	return {
		emit: async (eventName: string, event: unknown = {}) => {
			for (const handler of eventHandlers.get(eventName) ?? []) {
				await handler(event, ctx);
			}
		},
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
): Promise<AgentSnapshot> {
	const waited = await harness.call<WaitAgentsDetails>("wait_agents", {});
	expect(waited.details).toEqual(expect.any(Object));
	const agent = harness.store.getAgent(agentId);
	if (!agent || isActiveLifecycle(agent.lifecycle)) {
		throw new Error(`agent did not reach terminal state: ${agentId}`);
	}
	return agent;
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

function restoreOptionalEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

describe("multi-agent extension tools", () => {
	const childHarnesses: Harness[] = [];

	afterEach(() => {
		while (childHarnesses.length > 0) {
			childHarnesses.pop()?.cleanup();
		}
	});

	it("registers spawn/list/cancel/steer/contact/viewer tools", () => {
		const harness = createMultiAgentHarness();

		expect([...harness.tools.keys()].sort()).toEqual([
			"agent_artifacts",
			"agent_viewer",
			"attach_session_agent",
			"cancel_agent",
			"contact_supervisor",
			"list_agents",
			"send_agent_message",
			"spawn_agent",
			"steer_agent",
			"wait_agents",
		]);
		const waitTool = harness.tools.get("wait_agents");
		if (!waitTool) throw new Error("expected wait_agents tool");
		const waitParameters = waitTool.parameters as { properties: Record<string, unknown>; required?: string[] };
		expect(Object.keys(waitParameters.properties)).toEqual([]);
		expect(waitParameters.required).toBeUndefined();
		expect(waitParameters).toMatchObject({ additionalProperties: false });
		const cancelTool = harness.tools.get("cancel_agent");
		if (!cancelTool) throw new Error("expected cancel_agent tool");
		const cancelParameters = cancelTool.parameters as { properties: Record<string, unknown>; required?: string[] };
		expect(Object.keys(cancelParameters.properties)).toEqual(["agentId", "reason"]);
		expect(cancelParameters.required).toEqual(["agentId"]);
	});

	it("does not route multi-agent orchestration tools through generic approval", () => {
		const harness = createMultiAgentHarness();

		expect([...harness.tools.values()].map((tool) => [tool.name, tool.approvalRequired]).sort()).toEqual([
			["agent_artifacts", false],
			["agent_viewer", false],
			["attach_session_agent", false],
			["cancel_agent", false],
			["contact_supervisor", false],
			["list_agents", false],
			["send_agent_message", false],
			["spawn_agent", false],
			["steer_agent", false],
			["wait_agents", false],
		]);
	});

	it("registers split first-party modules over one shared multi-agent store", async () => {
		const harness = createSplitMultiAgentHarness();

		expect([...harness.tools.keys()].sort()).toEqual([
			"agent_artifacts",
			"agent_viewer",
			"attach_session_agent",
			"cancel_agent",
			"contact_supervisor",
			"list_agents",
			"send_agent_message",
			"spawn_agent",
			"steer_agent",
			"wait_agents",
		]);

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Split Worker",
			prompt: "Use shared store",
		});
		const viewed = await harness.call<AgentViewerDetails>("agent_viewer", { agentId: spawned.details.agent.id });
		const mailbox = mailboxDetails(harness.store, spawned.details.agent.id);

		expect(viewed.details.agent.id).toBe(spawned.details.agent.id);
		expect(mailbox.pendingCount).toBe(0);
		expect(harness.store.getAgent(spawned.details.agent.id)).toMatchObject({
			displayName: "Split Worker",
		});
	});

	it("attaches an existing saved session as an agent with preserved session identity", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-attach-session-agent-"));
		try {
			const savedSessionId = "019f29f4-0000-7000-8000-000000000001";
			const supervisorSessionId = "019f29f4-0000-7000-8000-000000000002";
			const savedSession = SessionManager.create("/repo", tempDir, { id: savedSessionId });
			savedSession.appendMessage({ role: "user", content: "saved prompt", timestamp: 1 });
			savedSession.appendMessage(fauxAssistantMessage("saved response"));
			const supervisorSession = SessionManager.create("/repo", tempDir, { id: supervisorSessionId });
			const controlDbPath = join(tempDir, "control.sqlite");
			savedSession.setMetadataControlDbPath(controlDbPath);
			supervisorSession.setMetadataControlDbPath(controlDbPath);
			const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			store.setPersistenceSessionManager(supervisorSession);
			const harness = createMultiAgentHarness({
				ctx: { controlDbPath, sessionManager: supervisorSession },
				store,
			});

			const attached = await harness.call<AttachSessionAgentDetails>("attach_session_agent", {
				displayName: "Saved Work",
				sessionId: savedSessionId,
			});
			const viewed = await harness.call<AgentViewerDetails>("agent_viewer", {
				agentId: attached.details.agent.id,
				sessionId: savedSessionId,
			});
			const steered = await harness.call<SteerAgentDetails>("steer_agent", {
				agentId: attached.details.agent.id,
				expectedRevision: attached.details.agent.revision,
				message: "Continue from saved work",
				targetCheckpoint: "when_waiting",
			});
			const sent = await harness.call<SendAgentMessageDetails>("send_agent_message", {
				message: "Mailbox request",
				toAgentId: attached.details.agent.id,
			});
			const agentBeforeCancel = harness.store.getAgent(attached.details.agent.id);
			if (!agentBeforeCancel) throw new Error("expected attached agent");
			const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
				agentId: attached.details.agent.id,
				reason: "stop saved work",
			});

			expect(attached.details).toMatchObject({
				agent: {
					agentType: "resumed-session",
					displayName: "Saved Work",
					lifecycle: "waiting_for_input",
					transcript: { path: savedSession.getSessionFile(), sessionId: savedSessionId },
				},
				dispatched: false,
			});
			expect(attached.details.agent.id).not.toBe(savedSessionId);
			expect(viewed.details.transcript).toEqual({
				agentId: attached.details.agent.id,
				path: savedSession.getSessionFile(),
				sessionId: savedSessionId,
			});
			expect(steered.details.message).toMatchObject({
				fromAgentId: "supervisor",
				kind: "steer",
				status: "pending",
				targetCheckpoint: "when_waiting",
				toAgentId: attached.details.agent.id,
			});
			expect(sent.details.message).toMatchObject({
				fromAgentId: "main",
				status: "pending",
				toAgentId: attached.details.agent.id,
			});
			expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
				{
					body: "Continue from saved work",
					recipient: { agentId: attached.details.agent.id, sessionId: savedSessionId },
				},
				{
					body: "Mailbox request",
					recipient: { agentId: attached.details.agent.id, sessionId: savedSessionId },
				},
			]);
			// Both messages honestly stay pending: the recipient session is not running
			// in this test, so the transport never delivers them.
			expect(harness.store.listMailboxMessages()).toMatchObject([
				{ id: steered.details.message.id, status: "pending" },
				{ id: sent.details.message.id, status: "pending" },
			]);
			expect(cancelled.details.agent).toMatchObject({ id: attached.details.agent.id, lifecycle: "aborted" });
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("dispatches and aborts a prompted attached session through the normal agent lifecycle", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-dispatch-attached-session-"));
		try {
			const savedSessionId = "019f29f4-0000-7000-8000-000000000003";
			const savedSession = SessionManager.create("/repo", tempDir, { id: savedSessionId });
			savedSession.appendMessage({ role: "user", content: "saved prompt", timestamp: 1 });
			savedSession.appendMessage(fauxAssistantMessage("saved response"));
			const childPrompt = deferred<void>();
			const abort = vi.fn();
			const createAttachedSession: AttachedSessionFactory = async ({ agent, sessionPath }) => {
				expect(agent.transcript).toEqual({ path: savedSession.getSessionFile(), sessionId: savedSessionId });
				expect(sessionPath).toBe(savedSession.getSessionFile());
				return {
					abort,
					messages: [],
					prompt: async () => childPrompt.promise,
					transcript: agent.transcript,
				};
			};
			const harness = createMultiAgentHarness({ createAttachedSession });

			const attached = await harness.call<AttachSessionAgentDetails>("attach_session_agent", {
				path: savedSession.getSessionFile(),
				prompt: "Continue saved work",
			});
			await Promise.resolve();
			const running = harness.store.getAgent(attached.details.agent.id);
			if (!running) {
				throw new Error("expected attached agent");
			}
			const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
				agentId: running.id,
				reason: "user requested",
			});

			expect(attached.details).toMatchObject({ dispatched: true, prompt: "Continue saved work" });
			expect(running).toMatchObject({ lifecycle: "running", transcript: { sessionId: savedSessionId } });
			expect(abort).toHaveBeenCalledTimes(1);
			expect(cancelled.details.agent).toMatchObject({ id: running.id, lifecycle: "aborted" });
			childPrompt.resolve(undefined);
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("reports attached session completion through wait_agents and the runtime mailbox", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-complete-attached-session-"));
		try {
			const savedSessionId = "019f29f4-0000-7000-8000-000000000004";
			const supervisorSessionId = "019f29f4-0000-7000-8000-000000000005";
			const savedSession = SessionManager.create("/repo", tempDir, { id: savedSessionId });
			savedSession.appendMessage({ role: "user", content: "saved prompt", timestamp: 1 });
			savedSession.appendMessage(fauxAssistantMessage("saved response"));
			const supervisorSession = SessionManager.create("/repo", tempDir, { id: supervisorSessionId });
			const controlDbPath = join(tempDir, "control.sqlite");
			supervisorSession.setMetadataControlDbPath(controlDbPath);
			const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			store.setPersistenceSessionManager(supervisorSession);
			const createAttachedSession: AttachedSessionFactory = async ({ agent }) => ({
				messages: [fauxAssistantMessage("attached complete")],
				prompt: async () => {},
				transcript: agent.transcript,
			});
			const harness = createMultiAgentHarness({
				createAttachedSession,
				ctx: { controlDbPath, sessionManager: supervisorSession },
				store,
			});

			const attached = await harness.call<AttachSessionAgentDetails>("attach_session_agent", {
				path: savedSession.getSessionFile(),
				prompt: "Finish saved work",
			});
			const waited = await waitForTerminalAgent(harness, attached.details.agent.id);

			expect(waited).toMatchObject({
				lifecycle: "completed",
				result: { summary: "attached complete" },
				transcript: { sessionId: savedSessionId },
			});
			expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
				{
					body: `Session ${savedSessionId} completed: attached complete`,
					recipient: { agentId: null, sessionId: supervisorSessionId },
					sender: { agentId: attached.details.agent.id, sessionId: savedSessionId },
				},
			]);
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("reports failed child session startup through the runtime mailbox", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-failed-child-session-"));
		try {
			const supervisorSessionId = "019f29f4-0000-7000-8000-000000000105";
			const supervisorSession = SessionManager.create("/repo", tempDir, { id: supervisorSessionId });
			const controlDbPath = getControlDbPath(tempDir);
			supervisorSession.setMetadataControlDbPath(controlDbPath);
			const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			store.setPersistenceSessionManager(supervisorSession);
			const createChildSession: ChildAgentSessionFactory = async () => {
				throw new Error("startup auth failed");
			};
			const harness = createMultiAgentHarness({
				createChildSession,
				ctx: { controlDbPath, sessionManager: supervisorSession },
				store,
			});

			const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
				displayName: "Failing worker",
				prompt: "start",
			});
			const waited = await waitForTerminalAgent(harness, spawned.details.agent.id);

			expect(waited).toMatchObject({
				error: { message: "startup auth failed" },
				lifecycle: "failed",
			});
			expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
				{
					body: "Failing worker failed: startup auth failed",
					recipient: { agentId: null, sessionId: supervisorSessionId },
					sender: { agentId: spawned.details.agent.id, sessionId: supervisorSessionId },
				},
			]);
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("references persisted store rows from mirrored runtime mailbox messages", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-mailbox-store-ref-"));
		try {
			const savedSessionId = "019f29f4-0000-7000-8000-000000000103";
			const supervisorSessionId = "019f29f4-0000-7000-8000-000000000104";
			const savedSession = SessionManager.create("/repo", tempDir, { id: savedSessionId });
			savedSession.appendMessage({ role: "user", content: "saved prompt", timestamp: 1 });
			savedSession.appendMessage(fauxAssistantMessage("saved response"));
			const supervisorSession = SessionManager.create("/repo", tempDir, { id: supervisorSessionId });
			const controlDbPath = getControlDbPath(tempDir);
			supervisorSession.setMetadataControlDbPath(controlDbPath);
			const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			store.setPersistenceSessionManager(supervisorSession);
			const createAttachedSession: AttachedSessionFactory = async ({ agent }) => ({
				messages: [fauxAssistantMessage("attached complete")],
				prompt: async () => {},
				transcript: agent.transcript,
			});
			const harness = createMultiAgentHarness({
				createAttachedSession,
				ctx: { controlDbPath, sessionManager: supervisorSession },
				store,
			});

			const attached = await harness.call<AttachSessionAgentDetails>("attach_session_agent", {
				path: savedSession.getSessionFile(),
				prompt: "Finish saved work",
			});
			await waitForTerminalAgent(harness, attached.details.agent.id);

			expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
				{
					body: `Session ${savedSessionId} completed: attached complete`,
					recipient: { agentId: null, sessionId: supervisorSessionId },
				},
			]);
			const db = createSqliteDatabase(controlDbPath);
			try {
				const raw = db
					.prepare("SELECT body, store_session_path, store_message_id FROM runtime_mailbox_messages")
					.all() as Array<{ body: string; store_session_path: string | null; store_message_id: string | null }>;
				expect(raw).toHaveLength(1);
				expect(raw[0].body).toBe("");
				expect(raw[0].store_session_path).toBe(supervisorSession.getSessionFile());
				expect(raw[0].store_message_id).toMatch(/^message_/);
			} finally {
				db.close();
			}
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("restarts recovered attached agents on session start without treating old handles as live", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = source.spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Recovered work",
			origin: "attached",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/recovered.jsonl", sessionId: "recovered-session" },
		});
		const started = source.transitionAgent(interrupted.agent.id, interrupted.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("expected recovered agent to start");
		expect(source.transitionAgent(interrupted.agent.id, started.agent.revision, "running").ok).toBe(true);
		const store = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});
		const recovered = store.getAgent(interrupted.agent.id);
		if (!recovered) throw new Error("expected recovered agent");
		const prompts: string[] = [];
		const createAttachedSession: AttachedSessionFactory = async ({ agent, sessionPath }) => {
			expect(agent.id).toBe(recovered.id);
			expect(agent.permission).toEqual(recovered.permission);
			expect(sessionPath).toBe("/sessions/recovered.jsonl");
			return {
				messages: [fauxAssistantMessage("recovered complete")],
				prompt: async (prompt) => {
					prompts.push(prompt);
				},
				transcript: agent.transcript,
			};
		};
		const harness = createMultiAgentHarness({ createAttachedSession, store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });
		const waited = await waitForTerminalAgent(harness, recovered.id);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Continue the conversation from where it left off");
		await harness.emit("session_start", { reason: "reload", type: "session_start" });
		expect(prompts).toHaveLength(1);
		expect(waited).toMatchObject({
			lifecycle: "completed",
			permission: recovered.permission,
			result: { summary: "recovered complete" },
			transcript: { path: "/sessions/recovered.jsonl", sessionId: "recovered-session" },
		});
	});

	it("ignores old dispatch completions after the store is rebound to another session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-stale-dispatch-generation-"));
		try {
			const savedSession = SessionManager.create("/repo", tempDir, {
				id: "019f29f4-0000-7000-8000-000000000099",
			});
			savedSession.appendMessage({ role: "user", content: "saved prompt", timestamp: 1 });
			savedSession.appendMessage(fauxAssistantMessage("saved response"));
			const createSessionGate = deferred<void>();
			const childPrompt = deferred<void>();
			const createAttachedSession: AttachedSessionFactory = async () => {
				await createSessionGate.promise;
				return {
					messages: [fauxAssistantMessage("old dispatch complete")],
					prompt: async () => childPrompt.promise,
					transcript: { path: "/sessions/stale-overwrite.jsonl", sessionId: "stale-session" },
				};
			};
			const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			const harness = createMultiAgentHarness({ createAttachedSession, store });
			await harness.call<AttachSessionAgentDetails>("attach_session_agent", {
				path: savedSession.getSessionFile(),
				prompt: "Continue saved work",
			});
			await Promise.resolve();

			const replacementSession = createControlDbSession();
			const replacementStore = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			replacementStore.setPersistenceSessionManager(replacementSession);
			const replacementAgent = replacementStore.spawnAgent({
				agentType: "worker",
				cwd: "/repo",
				displayName: "Scout",
				permission: { narrowed: true, policy: "on-request" },
			});
			store.restoreFromSessionManager(replacementSession);
			createSessionGate.resolve(undefined);
			childPrompt.resolve(undefined);
			await delay(5);

			expect(store.getAgent(replacementAgent.agent.id)).toMatchObject({
				displayName: "Scout",
				lifecycle: "queued",
				transcript: undefined,
			});
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("keeps live child session handles running across extension reload", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-reload-agent-handles-"));
		try {
			const savedSession = SessionManager.create("/repo", tempDir, {
				id: "019f29f4-0000-7000-8000-000000000101",
			});
			savedSession.appendMessage({ role: "user", content: "saved prompt", timestamp: 1 });
			savedSession.appendMessage(fauxAssistantMessage("saved response"));
			const childPrompt = deferred<void>();
			const abort = vi.fn();
			const createAttachedSession: AttachedSessionFactory = async ({ agent }) => ({
				abort,
				messages: [],
				prompt: async () => childPrompt.promise,
				transcript: agent.transcript,
			});
			const harness = createMultiAgentHarness({ createAttachedSession });
			const attached = await harness.call<AttachSessionAgentDetails>("attach_session_agent", {
				path: savedSession.getSessionFile(),
				prompt: "Continue saved work",
			});
			await Promise.resolve();

			await harness.emit("session_shutdown", { reason: "reload", type: "session_shutdown" });

			expect(abort).not.toHaveBeenCalled();
			expect(harness.store.getAgent(attached.details.agent.id)).toMatchObject({ lifecycle: "running" });
			childPrompt.resolve(undefined);
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("keeps shutdown-aborted agents recoverable instead of persisting them as failed", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-shutdown-abort-recoverable-"));
		try {
			const savedSession = SessionManager.create("/repo", tempDir, {
				id: "019f29f4-0000-7000-8000-000000000102",
			});
			savedSession.appendMessage({ role: "user", content: "saved prompt", timestamp: 1 });
			savedSession.appendMessage(fauxAssistantMessage("saved response"));
			const aborted = deferred<void>();
			const abort = vi.fn(() => aborted.resolve(undefined));
			const createAttachedSession: AttachedSessionFactory = async ({ agent }) => ({
				abort,
				messages: [],
				prompt: async () => {
					await aborted.promise;
					throw new Error("aborted by shutdown");
				},
				transcript: agent.transcript,
			});
			const harness = createMultiAgentHarness({ createAttachedSession });
			const attached = await harness.call<AttachSessionAgentDetails>("attach_session_agent", {
				path: savedSession.getSessionFile(),
				prompt: "Continue saved work",
			});
			await Promise.resolve();

			await harness.emit("session_shutdown", { reason: "resume", type: "session_shutdown" });
			await delay(5);

			expect(abort).toHaveBeenCalledOnce();
			expect(harness.store.getAgent(attached.details.agent.id)).toMatchObject({ lifecycle: "running" });
			expect(harness.store.getAgent(attached.details.agent.id)?.error).toBeUndefined();
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("aborts live child session handles on session shutdown before store rebind", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-shutdown-agent-handles-"));
		try {
			const savedSession = SessionManager.create("/repo", tempDir, {
				id: "019f29f4-0000-7000-8000-000000000100",
			});
			savedSession.appendMessage({ role: "user", content: "saved prompt", timestamp: 1 });
			savedSession.appendMessage(fauxAssistantMessage("saved response"));
			const childPrompt = deferred<void>();
			const abort = vi.fn();
			const createAttachedSession: AttachedSessionFactory = async ({ agent }) => ({
				abort,
				messages: [],
				prompt: async () => childPrompt.promise,
				transcript: agent.transcript,
			});
			const harness = createMultiAgentHarness({ createAttachedSession });
			await harness.call<AttachSessionAgentDetails>("attach_session_agent", {
				path: savedSession.getSessionFile(),
				prompt: "Continue saved work",
			});
			await Promise.resolve();

			await harness.emit("session_shutdown", { reason: "resume", type: "session_shutdown" });

			expect(abort).toHaveBeenCalledOnce();
			childPrompt.resolve(undefined);
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("aborts recovered spawned children instead of leaving detached active ghosts", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = source.spawnAgent({
			agentType: "implement",
			cwd: "/repo",
			displayName: "Spawned child",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/spawned-child.jsonl", sessionId: "spawned-child-session" },
		});
		const started = source.transitionAgent(interrupted.agent.id, interrupted.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("expected spawned child to start");
		expect(source.transitionAgent(interrupted.agent.id, started.agent.revision, "running").ok).toBe(true);
		const store = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});
		const createAttachedSession = vi.fn<AttachedSessionFactory>();
		const harness = createMultiAgentHarness({ createAttachedSession, store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });

		expect(createAttachedSession).not.toHaveBeenCalled();
		expect(store.getAgent(interrupted.agent.id)).toMatchObject({
			error: { message: "Spawned agent was interrupted by supervisor restart and cannot be resumed." },
			lifecycle: "aborted",
		});
		expect(store.getActiveAgentCount()).toBe(0);
	});

	it("aborts recovered spawned children that were waiting for input", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = source.spawnAgent({
			agentType: "explore",
			cwd: "/repo",
			displayName: "Waiting child",
			lifecycle: "waiting_for_input",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/waiting-child.jsonl", sessionId: "waiting-child-session" },
		});
		const store = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});
		const harness = createMultiAgentHarness({ store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });

		expect(store.getAgent(interrupted.agent.id)).toMatchObject({
			error: { message: "Spawned agent was interrupted by supervisor restart and cannot be resumed." },
			lifecycle: "aborted",
		});
		expect(store.getActiveAgentCount()).toBe(0);
	});

	it("waits for active background jobs that update store state without a dispatch", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const harness = createMultiAgentHarness({ store });
		const spawned = store.spawnAgent({
			agentType: "background",
			cwd: "/repo",
			displayName: "Background tool",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
			worker: { adapter: "runtime", handleId: "live-background-job" },
		});
		const running = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "running", {
			lastActivity: { description: "sleep", toolName: "bash" },
		});
		expect(running.ok).toBe(true);
		if (!running.ok) throw new Error("expected background job to be running");

		const waited = harness.call<WaitAgentsDetails>("wait_agents", {});
		expect(await resolvesWithin(waited, 10)).toBe(false);

		const current = store.getAgent(running.agent.id);
		expect(current).toBeDefined();
		if (!current) throw new Error("expected current background job");
		expect(store.transitionAgent(current.id, current.revision, "completed", { result: { summary: "done" } }).ok).toBe(
			true,
		);

		const result = await waited;
		expectWaitCompletionMessage(result, "Background tool completed: done");
		expect(store.getAgent(running.agent.id)).toMatchObject({
			id: running.agent.id,
			lifecycle: "completed",
			result: { summary: "done" },
		});
	});

	it("wait_agents observes terminal transitions from detached agents", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = source.spawnAgent({
			agentType: "implement",
			cwd: "/repo",
			displayName: "Detached child",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/detached-child.jsonl", sessionId: "detached-child-session" },
		});
		const started = source.transitionAgent(interrupted.agent.id, interrupted.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("expected start");
		expect(source.transitionAgent(interrupted.agent.id, started.agent.revision, "running").ok).toBe(true);
		const store = MultiAgentStore.fromSessionManager(session, { now: () => "2026-06-21T00:00:00.000Z" });
		const harness = createMultiAgentHarness({ store });

		const waitPromise = harness.call<WaitAgentsDetails>("wait_agents", {});
		expect(await resolvesWithin(waitPromise, 20)).toBe(false);
		const current = store.getAgent(interrupted.agent.id);
		if (!current) throw new Error("expected detached agent");
		expect(store.transitionAgent(current.id, current.revision, "aborted").ok).toBe(true);
		const waited = await waitPromise;

		expect(waited.details).toEqual({});
		expect(waited.content).toEqual([{ text: "Detached child is aborted.", type: "text" }]);
	});

	it("cancels a Hostrun wait for detached background agents", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const spawned = source.spawnAgent({
			agentType: "background",
			cwd: "/repo",
			displayName: "Detached background tool",
			lifecycle: "starting",
			permission: { narrowed: true, policy: "on-request" },
			worker: { adapter: "subprocess", handleId: "stale-process" },
		});
		const running = source.transitionAgent(spawned.agent.id, spawned.agent.revision, "running", {
			lastActivity: { description: "sleep", toolName: "bash" },
		});
		expect(running.ok).toBe(true);
		const store = MultiAgentStore.fromSessionManager(session, { now: () => "2026-06-21T00:00:00.000Z" });
		const handler = createHostrunMultiAgentRequestHandler({ store });
		const controller = new AbortController();
		const ctx = { cwd: "/repo", hasUI: false, mode: "print" } as ExtensionContext;
		const waitPromise = Promise.resolve(handler({ method: "agents.wait", params: {} }, ctx, controller.signal));
		expect(await resolvesWithin(waitPromise, 20)).toBe(false);
		controller.abort();
		const waited = await waitPromise;

		expect(waited).toBeNull();
	});

	it("fails detached agents without a transcript at recovery time", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = source.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "No transcript",
			permission: { narrowed: true, policy: "on-request" },
		});
		const started = source.transitionAgent(interrupted.agent.id, interrupted.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("expected start");
		expect(source.transitionAgent(interrupted.agent.id, started.agent.revision, "running").ok).toBe(true);
		const store = MultiAgentStore.fromSessionManager(session, { now: () => "2026-06-21T00:00:00.000Z" });
		const harness = createMultiAgentHarness({ store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });

		expect(store.getAgent(interrupted.agent.id)).toMatchObject({
			error: { message: "Spawned agent was interrupted by supervisor restart and cannot be resumed." },
			lifecycle: "aborted",
		});
	});

	it("completes pending cancels for detached cancelling agents at recovery time", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const cancelled = source.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Cancel pending",
			permission: { narrowed: true, policy: "on-request" },
		});
		const started = source.transitionAgent(cancelled.agent.id, cancelled.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("expected start");
		const running = source.transitionAgent(cancelled.agent.id, started.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) throw new Error("expected running");
		expect(source.transitionAgent(cancelled.agent.id, running.agent.revision, "cancelling").ok).toBe(true);
		const store = MultiAgentStore.fromSessionManager(session, { now: () => "2026-06-21T00:00:00.000Z" });
		const harness = createMultiAgentHarness({ store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });

		expect(store.getAgent(cancelled.agent.id)).toMatchObject({ lifecycle: "aborted" });
	});

	it("does not restart attached agents that were already waiting before restore", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const idle = store.spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Idle work",
			lifecycle: "waiting_for_input",
			origin: "attached",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/idle.jsonl", sessionId: "idle-session" },
		});
		const createAttachedSession = vi.fn<AttachedSessionFactory>();
		const harness = createMultiAgentHarness({ createAttachedSession, store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });

		expect(createAttachedSession).not.toHaveBeenCalled();
		expect(store.getAgent(idle.agent.id)).toMatchObject({ lifecycle: "waiting_for_input" });
	});

	it("does not run supervisor crash recovery inside child agent runtimes", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = source.spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Recovered work",
			origin: "attached",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/recovered.jsonl", sessionId: "recovered-session" },
		});
		const started = source.transitionAgent(interrupted.agent.id, interrupted.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("expected recovered agent to start");
		expect(source.transitionAgent(interrupted.agent.id, started.agent.revision, "running").ok).toBe(true);
		const store = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});
		const createAttachedSession = vi.fn<AttachedSessionFactory>();
		const harness = createMultiAgentHarness({
			createAttachedSession,
			ctx: { multiAgentAgentId: "agent_child" },
			store,
		});

		await harness.emit("session_start", { reason: "resume", type: "session_start" });

		expect(createAttachedSession).not.toHaveBeenCalled();
		expect(store.getAgent(interrupted.agent.id)).toMatchObject({ lifecycle: "running" });
	});

	it("marks recovered attached-session restart failures as failed with an inspectable error", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = source.spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Recovered work",
			origin: "attached",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/recovered.jsonl", sessionId: "recovered-session" },
		});
		const started = source.transitionAgent(interrupted.agent.id, interrupted.agent.revision, "starting");
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("expected recovered agent to start");
		expect(source.transitionAgent(interrupted.agent.id, started.agent.revision, "running").ok).toBe(true);
		const store = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});
		const recovered = store.getAgent(interrupted.agent.id);
		if (!recovered) throw new Error("expected recovered agent");
		const createAttachedSession: AttachedSessionFactory = async () => {
			throw new Error("recovery failed");
		};
		const harness = createMultiAgentHarness({ createAttachedSession, store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });
		const waited = await waitForTerminalAgent(harness, recovered.id);

		expect(waited).toMatchObject({
			error: { message: "recovery failed" },
			lifecycle: "failed",
			transcript: { path: "/sessions/recovered.jsonl", sessionId: "recovered-session" },
		});
	});

	it("marks attached session resume failures as failed with an inspectable error", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-fail-attached-session-"));
		try {
			const savedSessionId = "019f29f4-0000-7000-8000-000000000006";
			const savedSession = SessionManager.create("/repo", tempDir, { id: savedSessionId });
			savedSession.appendMessage({ role: "user", content: "saved prompt", timestamp: 1 });
			savedSession.appendMessage(fauxAssistantMessage("saved response"));
			const createAttachedSession: AttachedSessionFactory = async () => {
				throw new Error("resume failed");
			};
			const harness = createMultiAgentHarness({ createAttachedSession });

			const attached = await harness.call<AttachSessionAgentDetails>("attach_session_agent", {
				path: savedSession.getSessionFile(),
				prompt: "Continue saved work",
			});
			const waited = await waitForTerminalAgent(harness, attached.details.agent.id);

			expect(waited).toMatchObject({
				error: { message: "resume failed" },
				lifecycle: "failed",
				transcript: { sessionId: savedSessionId },
			});
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("keeps split first-party modules scoped to core, viewer, and mailbox tools", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });

		expect(collectTools((pi) => agentsCoreExtension(pi, { store }))).toEqual([
			"agent_artifacts",
			"attach_session_agent",
			"cancel_agent",
			"list_agents",
			"spawn_agent",
			"steer_agent",
			"wait_agents",
		]);
		expect(collectTools((pi) => agentViewerExtension(pi, { store }))).toEqual(["agent_viewer"]);
		expect(collectTools((pi) => agentsMailboxExtension(pi, { store }))).toEqual([
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
		await harness.call<WaitAgentsDetails>("wait_agents", {});
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

	it("lets Hostrun agents.wait return immediately when no agents are active", async () => {
		const handler = createHostrunMultiAgentRequestHandler({ store: new MultiAgentStore() });
		const ctx = { cwd: "/repo", hasUI: false, mode: "print" } as ExtensionContext;

		await expect(handler({ method: "agents.wait", params: {} }, ctx, undefined)).resolves.toBeNull();
	});

	it("rejects obsolete wait parameters", async () => {
		const harness = createMultiAgentHarness();
		const handler = createHostrunMultiAgentRequestHandler({ store: new MultiAgentStore() });
		const ctx = { cwd: "/repo", hasUI: false, mode: "print" } as ExtensionContext;

		await expect(handler({ method: "agents.wait", params: { agentId: "agent_1" } }, ctx, undefined)).rejects.toThrow(
			"pi.agents.wait does not accept parameters",
		);
		await expect(harness.call<WaitAgentsDetails>("wait_agents", { agentId: "agent_1" })).rejects.toThrow(
			"wait_agents does not accept parameters",
		);
	});

	it("rejects nested agent orchestration through direct tools", async () => {
		const harness = createMultiAgentHarness({ ctx: { multiAgentAgentId: "agent_child" } });

		for (const [toolName, params] of [
			["spawn_agent", { displayName: "Nested", prompt: "do work" }],
			["attach_session_agent", { sessionId: "saved-session" }],
			["wait_agents", {}],
		] as const) {
			const result = await harness.call<Record<string, unknown>>(toolName, params);
			expect(result.content).toMatchObject([
				{ text: expect.stringContaining("unavailable from child agent runtimes") },
			]);
		}
		expect(harness.store.listAgents()).toEqual([]);
	});

	it("rejects nested agent orchestration through Hostrun and Pyrun bridge methods", async () => {
		const store = new MultiAgentStore();
		const handler = createHostrunMultiAgentRequestHandler({ store });
		const ctx = {
			cwd: "/repo",
			hasUI: false,
			mode: "print",
			multiAgentAgentId: "agent_child",
			multiAgentRequiresAgentId: true,
		} as ExtensionContext;

		for (const request of [
			{ method: "agents.spawn", params: { displayName: "Nested", prompt: "do work" } },
			{ method: "agents.attachSession", params: { sessionId: "saved-session" } },
			{ method: "agents.wait", params: {} },
		]) {
			await expect(handler(request, ctx, undefined)).rejects.toThrow("unavailable from child agent runtimes");
		}
		expect(store.listAgents()).toEqual([]);
	});

	it("rejects /bg from child agent runtimes", async () => {
		const notify = vi.fn();
		const harness = createMultiAgentHarness();

		await harness.command("bg", "nested work", {
			multiAgentAgentId: "agent_child",
			ui: { notify },
		});

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("unavailable from child agent runtimes"), "error");
		expect(harness.store.listAgents()).toEqual([]);
	});

	it("lets tool wait_agents observe Hostrun-spawned live dispatches through shared runtime handles", async () => {
		const finishGate = deferred<void>();
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const dispatcher: ChildAgentDispatcher = async () => {
			await finishGate.promise;
			return { lifecycle: "completed", result: { summary: "hostrun done" } };
		};
		const handler = createHostrunMultiAgentRequestHandler({ dispatcher, runtimeHandles, store });
		const harness = createMultiAgentHarness({ dispatcher, runtimeHandles, store });
		const ctx = { cwd: "/repo", hasUI: false, mode: "print" } as ExtensionContext;

		const spawned = (await handler(
			{ method: "agents.spawn", params: { displayName: "Worker", prompt: "hostrun work" } },
			ctx,
			undefined,
		)) as SpawnAgentDetails;
		const waitPromise = harness.call<WaitAgentsDetails>("wait_agents", {});
		const didResolveBeforeFinish = await resolvesWithin(waitPromise, 20);
		finishGate.resolve(undefined);
		const waited = await waitPromise;

		expect(didResolveBeforeFinish).toBe(false);
		expectWaitCompletionMessage(waited, "Worker completed: hostrun done");
		expect(store.getAgent(spawned.agent.id)).toMatchObject({
			id: spawned.agent.id,
			lifecycle: "completed",
			result: { summary: "hostrun done" },
		});
	});

	it("lets tool cancel_agent abort Hostrun-spawned child sessions through shared runtime handles", async () => {
		const abort = vi.fn();
		const childPrompt = deferred<void>();
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const createChildSession: ChildAgentSessionFactory = async () => ({
			abort,
			messages: [],
			prompt: async () => childPrompt.promise,
		});
		const handler = createHostrunMultiAgentRequestHandler({ createChildSession, runtimeHandles, store });
		const harness = createMultiAgentHarness({ createChildSession, runtimeHandles, store });
		const ctx = { cwd: "/repo", hasUI: false, mode: "print" } as ExtensionContext;

		const spawned = (await handler(
			{ method: "agents.spawn", params: { displayName: "Worker", prompt: "hostrun work" } },
			ctx,
			undefined,
		)) as SpawnAgentDetails;
		for (let attempt = 0; attempt < 20 && !runtimeHandles.sessions.has(spawned.agent.id); attempt += 1) {
			await delay(1);
		}
		const current = store.getAgent(spawned.agent.id);
		if (!current) throw new Error("expected spawned agent");
		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: current.id,
			reason: "stop hostrun child",
		});

		expect(abort).toHaveBeenCalledOnce();
		expect(cancelled.details.agent).toMatchObject({ id: spawned.agent.id, lifecycle: "aborted" });
	});

	it("lets Escape's store abort path stop a production child session", async () => {
		const childPrompt = deferred<void>();
		const abort = vi.fn(() => childPrompt.resolve());
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const createChildSession: ChildAgentSessionFactory = async () => ({
			abort,
			messages: [],
			prompt: async () => childPrompt.promise,
		});
		const harness = createMultiAgentHarness({ createChildSession, runtimeHandles, store });

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "production work",
		});
		for (let attempt = 0; attempt < 20 && !runtimeHandles.sessions.has(spawned.details.agent.id); attempt += 1) {
			await delay(1);
		}
		const current = store.getAgent(spawned.details.agent.id);
		if (!current) throw new Error("expected spawned agent");
		const cancelled = store.transitionAgent(current.id, current.revision, "aborted");
		expect(cancelled.ok).toBe(true);

		expect(store.abortAgentHandle(current.id)).toBe(true);
		expect(abort).toHaveBeenCalledOnce();
		expect(store.getAgent(current.id)).toMatchObject({ lifecycle: "aborted" });
	});

	it("does not prompt a child session cancelled while the session factory is starting", async () => {
		const factoryGate = deferred<void>();
		const abort = vi.fn();
		const prompt = vi.fn(async () => {});
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const createChildSession: ChildAgentSessionFactory = async () => {
			await factoryGate.promise;
			return { abort, messages: [], prompt };
		};
		const harness = createMultiAgentHarness({ createChildSession, runtimeHandles, store });

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "production work",
		});
		const current = store.getAgent(spawned.details.agent.id);
		if (!current) throw new Error("expected spawned agent");
		const cancelled = store.transitionAgent(current.id, current.revision, "aborted");
		expect(cancelled.ok).toBe(true);
		expect(store.abortAgentHandle(current.id)).toBe(false);

		factoryGate.resolve();
		for (let attempt = 0; attempt < 20 && abort.mock.calls.length === 0; attempt += 1) {
			await delay(1);
		}

		expect(abort).toHaveBeenCalledOnce();
		expect(prompt).not.toHaveBeenCalled();
		expect(runtimeHandles.sessions.has(current.id)).toBe(false);
		expect(store.getAgent(current.id)).toMatchObject({ lifecycle: "aborted" });
	});

	it("cancels after child transcript metadata attaches without caller revision", async () => {
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
			reason: "user requested",
		});

		expect(cancelled.details.agent).toMatchObject({
			id: spawned.details.agent.id,
			lifecycle: "aborted",
		});
	});

	it("cancels a /bg child session without caller revision", async () => {
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
			reason: "user requested",
		});

		expect(cancelled.details.agent).toMatchObject({ id: agent.id, lifecycle: "aborted" });
		expect(abort).toHaveBeenCalledTimes(1);
		expect(harness.store.getAgent(agent.id)).toMatchObject({ lifecycle: "aborted" });
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

	it("lists only active agents by default while allowing inactive agents when requested", async () => {
		const harness = createMultiAgentHarness();
		const active = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Active",
			prompt: "Active task",
		});
		const completed = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Completed",
			prompt: "Completed task",
		});
		const terminal = completeAgent(harness.store, completed.details.agent);

		const defaultList = await harness.call<ListAgentsDetails>("list_agents", {});
		const fullList = await harness.call<ListAgentsDetails>("list_agents", { activeOnly: false });

		expect(terminal.lifecycle).toBe("completed");
		expect(defaultList.details.agents.map((agent) => agent.id)).toEqual([active.details.agent.id]);
		expect(fullList.details.agents.map((agent) => agent.id)).toEqual([
			active.details.agent.id,
			completed.details.agent.id,
		]);
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

	it("views a persisted agent from another supervisor session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-viewer-store-session-"));
		managedTempDirs.push(tempDir);
		const supervisorSessionId = "019f39aa-0000-7000-8000-000000000001";
		const currentSessionId = "019f39aa-0000-7000-8000-000000000002";
		const supervisorSession = SessionManager.create("/repo", tempDir, { id: supervisorSessionId });
		const currentSession = SessionManager.create("/repo", tempDir, { id: currentSessionId });
		const controlDbPath = join(tempDir, "control.sqlite");
		supervisorSession.setMetadataControlDbPath(controlDbPath);
		currentSession.setMetadataControlDbPath(controlDbPath);
		const supervisorStore = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		supervisorStore.setPersistenceSessionManager(supervisorSession);
		const agent = supervisorStore.spawnAgent({
			agentType: "verifier",
			cwd: "/repo",
			displayName: "Verifier",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "sessions/verifier.jsonl", sessionId: "child-session" },
		});
		const completed = completeAgent(supervisorStore, agent.agent);
		const currentStore = MultiAgentStore.fromSessionManager(currentSession, {
			now: () => "2026-06-21T00:00:00.000Z",
		});
		const harness = createMultiAgentHarness({
			ctx: { controlDbPath, sessionManager: currentSession },
			store: currentStore,
		});

		const viewed = await harness.call<AgentViewerDetails>("agent_viewer", {
			agentId: agent.agent.id,
			storeSessionId: supervisorSessionId,
		});

		expect(harness.store.getAgent(agent.agent.id)).toBeUndefined();
		expect(viewed.details).toMatchObject({
			agent: { id: agent.agent.id, lifecycle: "completed", revision: completed.revision },
			children: [],
			status: { agentId: agent.agent.id, lifecycle: "completed", revision: completed.revision, terminal: true },
			transcript: { agentId: agent.agent.id, path: "sessions/verifier.jsonl", sessionId: "child-session" },
		});
	});

	it("views one agent without lifecycle mutation", async () => {
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

		const viewed = await harness.call<AgentViewerDetails>("agent_viewer", { agentId: child.details.agent.id });
		const afterView = harness.store.getAgent(child.details.agent.id);

		expect(viewed.details).toMatchObject({
			agent: { id: child.details.agent.id, lifecycle: "queued", revision: pinned.agent.revision },
			children: [],
			parentId: parent.details.agent.id,
			status: {
				agentId: child.details.agent.id,
				lifecycle: "queued",
				revision: pinned.agent.revision,
				terminal: false,
			},
		});
		expect(afterView).toMatchObject({
			id: child.details.agent.id,
			lifecycle: "queued",
			revision: pinned.agent.revision,
		});
	});

	it("exposes read-only status transcript and command descriptors in agent_viewer", async () => {
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

		const viewed = await harness.call<AgentViewerDetails>("agent_viewer", { agentId: child.agent.id });

		expect(viewed.details).toMatchObject({
			agent: { id: child.agent.id, lifecycle: "starting", revision: running.agent.revision },
			children: [],
			parentId: parent.agent.id,
			status: { agentId: child.agent.id, lifecycle: "starting", revision: running.agent.revision, terminal: false },
			transcript: { agentId: child.agent.id, path: "sessions/child.jsonl", sessionId: "child-session" },
		});
		expect(viewed.details.commands).toEqual(
			expect.arrayContaining([
				{ agentId: child.agent.id, command: "stop", tool: "cancel_agent" },
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

		const childMailbox = mailboxDetails(harness.store, child.details.agent.id);
		const parentMailbox = mailboxDetails(harness.store, parent.details.agent.id);
		const childAfterMailbox = harness.store.getAgent(child.details.agent.id);

		expect(childMailbox).toMatchObject({
			acknowledgements: [{ id: steered.details.message.id, status: "accepted" }],
			inbox: [{ id: steered.details.message.id, fromAgentId: "supervisor", status: "accepted" }],
			outbox: [{ id: contact.details.message.id, toAgentId: parent.details.agent.id, status: "pending" }],
			pendingCount: 1,
		});
		expect(parentMailbox).toMatchObject({
			inbox: [{ id: contact.details.message.id, fromAgentId: child.details.agent.id, status: "pending" }],
			pendingCount: 1,
		});
		expect(childAfterMailbox).toMatchObject({
			id: child.details.agent.id,
			revision: contact.details.agent.revision,
		});
	});

	it("sends direct parent-child mailbox messages and rejects sibling targets", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-send-agent-message-"));
		try {
			const parentSession = SessionManager.create("/repo", tempDir, { id: "parent-session" });
			const childSession = SessionManager.create("/repo", tempDir, { id: "child-session" });
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
			const parentTranscript = harness.store.updateAgentTranscript(parent.details.agent.id, {
				sessionId: parentSession.getSessionId(),
			});
			expect(parentTranscript.ok).toBe(true);
			const childTranscript = harness.store.updateAgentTranscript(child.details.agent.id, {
				sessionId: childSession.getSessionId(),
			});
			expect(childTranscript.ok).toBe(true);
			const sendAgentMessage = harness.tools.get("send_agent_message");
			if (!sendAgentMessage) {
				throw new Error("expected send_agent_message tool");
			}

			const sent = (await sendAgentMessage.execute(
				"send-parent",
				{ message: "Please inspect auth", toAgentId: child.details.agent.id },
				undefined,
				undefined,
				{
					cwd: "/repo",
					hasUI: false,
					mode: "print",
					multiAgentAgentId: parent.details.agent.id,
					sessionManager: parentSession,
				} as unknown as ExtensionContext,
			)) as AgentToolResult<SendAgentMessageDetails>;
			const rejected = (await sendAgentMessage.execute(
				"send-child",
				{ message: "Can I read your state?", toAgentId: sibling.details.agent.id },
				undefined,
				undefined,
				{
					cwd: "/repo",
					hasUI: false,
					mode: "print",
					multiAgentAgentId: child.details.agent.id,
					sessionManager: childSession,
				} as unknown as ExtensionContext,
			)) as AgentToolResult<SendAgentMessageDetails>;
			const childMailbox = mailboxDetails(harness.store, child.details.agent.id);

			expect(sent.details.message).toMatchObject({
				body: "Please inspect auth",
				fromAgentId: parent.details.agent.id,
				kind: "message",
				status: "pending",
				toAgentId: child.details.agent.id,
			});
			expect(childMailbox.inbox).toMatchObject([{ id: sent.details.message.id }]);
			expect(rejected.details).toMatchObject({
				agent: { id: child.details.agent.id, revision: child.details.agent.revision },
				message: { status: "failed", toAgentId: sibling.details.agent.id },
			});
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("derives the main thread as sender for top-level agent messages", async () => {
		const harness = createMultiAgentHarness();
		const child = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Top-level child",
			prompt: "Child task",
		});

		const sent = await harness.call<SendAgentMessageDetails>("send_agent_message", {
			message: "Main thread request",
			toAgentId: child.details.agent.id,
		});
		const childMailbox = mailboxDetails(harness.store, child.details.agent.id);

		expect(sent.details.message).toMatchObject({
			body: "Main thread request",
			fromAgentId: "main",
			kind: "message",
			status: "pending",
			toAgentId: child.details.agent.id,
		});
		expect(childMailbox.inbox).toMatchObject([{ id: sent.details.message.id }]);
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
		const waited = workflow.waitAgents();

		expect(message.ok).toBe(true);
		expect(waited).toBeUndefined();
		expect(store.getAgent(parent.agent.id)).toMatchObject({ id: parent.agent.id });
		expect(store.listDescendants(parent.agent.id)).toMatchObject([{ id: child.agent.id }]);
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

		const waiting = harness.call<WaitAgentsDetails>("wait_agents", {});
		expect(await resolvesWithin(waiting, 20)).toBe(false);
		expect(harness.store.getAgent(agent.id)).toMatchObject({ id: agent.id, lifecycle: "queued" });

		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: agent.id,
			reason: "user stopped it",
		});
		expect(cancelled.details.agent).toMatchObject({
			id: agent.id,
			lifecycle: "aborted",
			revision: agent.revision + 1,
		});
		expect(cancelled.details.reason).toBe("user stopped it");
		expect(await waiting).toEqual({ content: [{ text: "Worker is aborted.", type: "text" }], details: {} });
		expect(harness.store.getActiveAgentCount()).toBe(0);
	});

	it("wait_agents returns immediately when no agents are active", async () => {
		const harness = createMultiAgentHarness();

		const waited = await harness.call<WaitAgentsDetails>("wait_agents", {});

		expect(waited).toEqual({ content: [], details: {} });
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

	it("wait_agents returns when any active agent reaches a terminal state", async () => {
		const firstGate = deferred<void>();
		const secondGate = deferred<void>();
		const dispatcher: ChildAgentDispatcher = async ({ agent }) => {
			await (agent.displayName === "First" ? firstGate.promise : secondGate.promise);
			return { lifecycle: "completed", result: { summary: `${agent.displayName} done` } };
		};
		const harness = createMultiAgentHarness({ dispatcher });
		const first = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "First",
			prompt: "First task",
		});
		const second = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Second",
			prompt: "Second task",
		});

		const waitPromise = harness.call<WaitAgentsDetails>("wait_agents", {});
		const didResolveBeforeCompletion = await resolvesWithin(waitPromise, 20);
		secondGate.resolve(undefined);
		const waited = await waitPromise;

		expect(didResolveBeforeCompletion).toBe(false);
		expectWaitCompletionMessage(waited, "Second completed: Second done");
		expect(harness.store.getAgent(first.details.agent.id)).toMatchObject({ lifecycle: "running" });
		expect(harness.store.getAgent(second.details.agent.id)).toMatchObject({ lifecycle: "completed" });
		firstGate.resolve(undefined);
	});

	it("wakes an idle main parent when a child completion notification arrives", async () => {
		const childPrompt = deferred<void>();
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const createChildSession: ChildAgentSessionFactory = async () => ({
			messages: [fauxAssistantMessage("child done")],
			prompt: async () => childPrompt.promise,
		});
		const harness = await createHarness({
			extensionFactories: [(pi) => multiAgentExtension(pi, { createChildSession, store })],
			multiAgentStore: store,
			persistedSession: true,
		});
		childHarnesses.push(harness);
		store.setPersistenceSessionManager(harness.sessionManager);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("spawn_agent", { displayName: "Worker", prompt: "child work" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("parent idle"),
			fauxAssistantMessage("parent woke"),
		]);

		await harness.session.prompt("start child");
		await harness.session.agent.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start child"]);

		childPrompt.resolve(undefined);
		for (let attempt = 0; attempt < 50 && !getAssistantTexts(harness).includes("parent woke"); attempt += 1) {
			await delay(1);
		}
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([
			"start child",
			["From:", "- agent: agent_1", "", "Message:", "Worker completed: child done"].join("\n"),
		]);
		expect(getAssistantTexts(harness)).toContain("parent idle");
		expect(getAssistantTexts(harness)).toContain("parent woke");
		expect(store.listMailboxMessages()).toMatchObject([{ status: "delivered" }]);
	});

	it("includes mailbox artifact references in the runtime mailbox follow-up", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const harness = await createHarness({
			extensionFactories: [(pi) => multiAgentExtension(pi, { store })],
			multiAgentStore: store,
			persistedSession: true,
		});
		childHarnesses.push(harness);
		store.setPersistenceSessionManager(harness.sessionManager);
		const controlDbPath = harness.sessionManager.getMetadataControlDbPath();
		const sessionPath = harness.sessionManager.getSessionFile();
		if (!controlDbPath || !sessionPath) throw new Error("expected control DB session");
		const child = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
		});
		const contacted = store.contactSupervisor(child.agent.id, child.agent.revision, {
			artifactIds: ["artifact_1"],
			artifactRefs: [{ id: "artifact_2", label: "Test log", path: "artifacts/test.log" }],
			body: "Review log",
		});
		if (!contacted.ok) throw new Error("expected supervisor contact");
		harness.setResponses([fauxAssistantMessage("initial reply"), fauxAssistantMessage("mailbox reply")]);
		enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "supervisor_request",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: child.agent.id, sessionId: harness.sessionManager.getSessionId() },
			storeRef: { messageId: contacted.message.id, sessionPath },
		});
		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();
		for (let attempt = 0; attempt < 50 && store.listMailboxMessages()[0]?.status !== "delivered"; attempt += 1) {
			await delay(1);
		}

		const followUp = getUserTexts(harness).find((text) => text.includes("Review log"));
		expect(followUp).toContain("Artifact IDs:\n- artifact_1");
		expect(followUp).toContain("Artifact references:\n- Test log — artifact_2 — artifacts/test.log");
		expect(store.listMailboxMessages()).toMatchObject([{ id: contacted.message.id, status: "delivered" }]);
	});

	it("wait_agents does not repeat an already delivered completion", async () => {
		const harness = createMultiAgentHarness();
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "Complete before wait",
		});
		const starting = harness.store.transitionAgent(
			spawned.details.agent.id,
			spawned.details.agent.revision,
			"starting",
		);
		expect(starting.ok).toBe(true);
		if (!starting.ok) throw new Error("expected starting transition");
		const running = harness.store.transitionAgent(starting.agent.id, starting.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) throw new Error("expected running transition");
		const completed = harness.store.transitionAgent(running.agent.id, running.agent.revision, "completed", {
			result: { summary: "already delivered" },
		});
		expect(completed.ok).toBe(true);
		harness.store.consumeCompletionNotificationsForAgent(spawned.details.agent.id);

		const waited = await harness.call<WaitAgentsDetails>("wait_agents", {});

		expect(waited).toEqual({ content: [], details: {} });
	});

	it("wait_agents waits for a dispatched agent to complete and consumes the parent completion mailbox message", async () => {
		const idleGate = deferred<void>();
		const finishGate = deferred<void>();
		const idleState = deferred<void>();
		const session = createControlDbSession();
		const controlDbPath = session.getMetadataControlDbPath();
		if (!controlDbPath) throw new Error("expected control DB path");
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		store.setPersistenceSessionManager(session);
		const parent = store.spawnAgent({
			agentType: "lead",
			cwd: "/repo",
			displayName: "Lead",
			permission: { narrowed: true, policy: "on-request" },
		});
		const dispatcher: ChildAgentDispatcher = async ({ agent }) => {
			await idleGate.promise;
			const waiting = store.transitionAgent(agent.id, agent.revision, "waiting_for_input");
			expect(waiting.ok).toBe(true);
			idleState.resolve(undefined);
			await finishGate.promise;
			return { lifecycle: "completed", result: { artifactIds: ["artifact_1"], summary: "done" } };
		};
		const harness = createMultiAgentHarness({ ctx: { controlDbPath, sessionManager: session }, dispatcher, store });
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			parentId: parent.agent.id,
			prompt: "Need input before finishing",
		});

		const waitPromise = harness.call<WaitAgentsDetails>("wait_agents", {});
		const didResolveBeforeIdle = await resolvesWithin(waitPromise, 20);
		idleGate.resolve(undefined);
		await idleState.promise;
		const didResolveAfterIdle = await resolvesWithin(waitPromise, 100);
		finishGate.resolve(undefined);
		const waited = await waitPromise;

		expect(didResolveBeforeIdle).toBe(false);
		expect(didResolveAfterIdle).toBe(false);
		expect(waited.content).toEqual([{ text: "Worker completed: done", type: "text" }]);
		expect(waited.details.message).toMatchObject({
			artifactIds: ["artifact_1"],
			body: "Worker completed: done",
			fromAgentId: spawned.details.agent.id,
			kind: "system",
			status: "delivered",
			toAgentId: parent.agent.id,
		});
		expect(store.getAgent(spawned.details.agent.id)).toMatchObject({
			id: spawned.details.agent.id,
			lifecycle: "completed",
			result: { artifactIds: ["artifact_1"], summary: "done" },
		});
		expect(store.listMailboxMessages()).toMatchObject([
			{
				body: "Worker is waiting for input.",
				fromAgentId: spawned.details.agent.id,
				kind: "system",
				status: "pending",
				toAgentId: parent.agent.id,
			},
			{
				artifactIds: ["artifact_1"],
				body: "Worker completed: done",
				fromAgentId: spawned.details.agent.id,
				kind: "system",
				status: "delivered",
				toAgentId: parent.agent.id,
			},
		]);
		expect(
			listRuntimeMailboxMessages(controlDbPath).filter(
				(message) => message.sender.agentId === spawned.details.agent.id,
			),
		).toMatchObject([
			{ kind: "system", status: "pending" },
			{ kind: "system", status: "delivered" },
		]);
	});

	it("routes completed notices for main-thread children to the main mailbox", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			permission: { narrowed: true, policy: "on-request" },
		});
		const starting = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "starting");
		expect(starting.ok).toBe(true);
		if (!starting.ok) throw new Error("expected starting transition");
		const running = store.transitionAgent(starting.agent.id, starting.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) throw new Error("expected running transition");
		const waiting = store.transitionAgent(running.agent.id, running.agent.revision, "waiting_for_input");
		expect(waiting.ok).toBe(true);
		if (!waiting.ok) throw new Error("expected waiting transition");
		expect(store.listMailboxMessages()).toMatchObject([
			{
				body: "Worker is waiting for input.",
				fromAgentId: spawned.agent.id,
				kind: "system",
				status: "pending",
				toAgentId: "main",
			},
		]);
		const completed = store.transitionAgent(waiting.agent.id, waiting.agent.revision, "completed", {
			result: { summary: "done" },
		});
		expect(completed.ok).toBe(true);

		expect(store.listMailboxMessages()).toMatchObject([
			{
				body: "Worker is waiting for input.",
				fromAgentId: spawned.agent.id,
				kind: "system",
				status: "pending",
				toAgentId: "main",
			},
			{
				body: "Worker completed: done",
				fromAgentId: spawned.agent.id,
				kind: "system",
				status: "pending",
				toAgentId: "main",
			},
		]);
	});

	it("wait_agents returns no output once store state is terminal even when a tracked dispatch is still settling", async () => {
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

		const waitPromise = harness.call<WaitAgentsDetails>("wait_agents", {});
		const didResolveBeforeTerminal = await resolvesWithin(waitPromise, 20);
		terminalGate.resolve(undefined);
		await terminalState.promise;
		const didResolveAfterTerminal = await resolvesWithin(waitPromise, 100);
		dispatchGate.resolve(undefined);
		const waited = await waitPromise;

		expect(didResolveBeforeTerminal).toBe(false);
		expect(didResolveAfterTerminal).toBe(true);
		expectWaitCompletionMessage(waited, "Worker completed: done");
		expect(store.getAgent(spawned.details.agent.id)).toMatchObject({
			id: spawned.details.agent.id,
			lifecycle: "completed",
			result: { summary: "done" },
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
		expect(waited).toMatchObject({ id: spawned.details.agent.id, lifecycle: "completed" });
	});

	it("returns the consumed completion message after wait_agents observes completion", async () => {
		const dispatcher: ChildAgentDispatcher = async () => ({
			lifecycle: "completed",
			result: { summary: "Committed 18125d44 feat: add local deploy script" },
		});
		const harness = createMultiAgentHarness({ dispatcher });

		await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "commit workflow",
			prompt: "Commit current changes",
		});
		const waited = await harness.call<Record<string, unknown>>("wait_agents", {});

		expectWaitCompletionMessage(
			waited,
			"commit workflow completed: Committed 18125d44 feat: add local deploy script",
		);
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
		expect(waited).toMatchObject({ id: spawned.details.agent.id, lifecycle: "completed" });
	});

	it("wires spawn_agent to a production child AgentSession factory with parent session metadata", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		let childHarness: Harness | undefined;
		let sessionOptions: CreateAgentSessionOptions | undefined;
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const childSessionDir = `${parentHarness.tempDir}/child-sessions`;
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			store,
			createChildSession: createProductionChildAgentSessionFactory({
				sessionDir: childSessionDir,
				createSessionManager: SessionManager.create,
				multiAgentStore: store,
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
			excludeTools: ["attach_session_agent", "spawn_agent", "wait_agents"],
			model: parentHarness.getModel(),
			modelRegistry: parentHarness.session.modelRegistry,
		});
		expect(sessionOptions?.sessionManager?.getHeader()).toMatchObject({
			cwd: "/repo",
			parentSession: parentHarness.sessionManager.getSessionId(),
		});
		expect(sessionOptions?.sessionManager?.getSessionDir()).toBe(childSessionDir);
		expect(sessionOptions?.sessionStartEvent).toEqual({ type: "session_start", reason: "fork" });
		expect(sessionOptions?.multiAgentStore).toBe(store);

		expect(childHarness).toBeDefined();
		if (!childHarness) {
			throw new Error("expected child harness");
		}
		expect(getUserTexts(childHarness)).toEqual(["Implement auth tests"]);
		expect(getAssistantTexts(childHarness)).toEqual(["factory child done"]);
		expect(spawned.details).toMatchObject({
			dispatched: true,
		});
		expect(waited).toMatchObject({
			id: spawned.details.agent.id,
			lifecycle: "completed",
			result: { summary: "factory child done" },
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
		const originalSelfRestartSession = process.env[ENV_SELF_RESTART_SESSION];
		const originalSelfRestartPrompt = process.env[ENV_SELF_RESTART_PROMPT];
		const originalSelfRestartOldPid = process.env[ENV_SELF_RESTART_OLD_PID];
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
			delete process.env[ENV_SELF_RESTART_SESSION];
			delete process.env[ENV_SELF_RESTART_PROMPT];
			delete process.env[ENV_SELF_RESTART_OLD_PID];
			process.chdir(projectDir);
			await main(["-p", "spawn a child", "--model", `${model.provider}/${model.id}`, "--no-session"], {
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
			restoreOptionalEnv(ENV_SELF_RESTART_SESSION, originalSelfRestartSession);
			restoreOptionalEnv(ENV_SELF_RESTART_PROMPT, originalSelfRestartPrompt);
			restoreOptionalEnv(ENV_SELF_RESTART_OLD_PID, originalSelfRestartOldPid);
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("passes the shared store into production attached AgentSession factories", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const target = SessionManager.create("/repo", parentHarness.tempDir, { id: "attached-session" });
		target.appendMessage({ role: "user", content: "existing", timestamp: 1 });
		let sessionOptions: CreateAgentSessionOptions | undefined;
		const attachedFactory = createProductionAttachedSessionFactory({
			createSession: async (options) => {
				sessionOptions = options;
				return { session: { messages: [], prompt: async () => {} } };
			},
			multiAgentStore: store,
		});
		const agent = store.spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Attached",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: target.getSessionFile(), sessionId: target.getSessionId() },
		}).agent;

		await attachedFactory({
			agent,
			ctx: {
				cwd: "/repo",
				hasUI: false,
				mode: "print",
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			} as unknown as ExtensionContext,
			prompt: "resume",
			sessionPath: target.getSessionFile() ?? "",
		});

		expect(sessionOptions).toMatchObject({
			excludeTools: ["attach_session_agent", "spawn_agent", "wait_agents"],
			multiAgentStore: store,
		});
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

	it("seeds a session-local goal from the spawn prompt before the child starts", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		parentHarness.sessionManager.setSessionGoalJson(
			JSON.stringify({ objective: "parent objective", branch: "test", createdAt: "2026-01-01T00:00:00.000Z" }),
		);
		let childGoalBeforePrompt: string | undefined;
		let childSessionManager: SessionManager | undefined;
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				createSessionManager: SessionManager.create,
				createSession: async (options) => {
					childSessionManager = options.sessionManager;
					return {
						session: {
							messages: [],
							prompt: async () => {
								childGoalBeforePrompt = childSessionManager?.getSessionGoalJson();
							},
						},
					};
				},
			}),
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			displayName: "Worker",
			prompt: "  Map the child scope  ",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(JSON.parse(childGoalBeforePrompt ?? "{}")).toMatchObject({ objective: "Map the child scope" });
		expect(JSON.parse(parentHarness.sessionManager.getSessionGoalJson() ?? "{}")).toMatchObject({
			objective: "parent objective",
		});
	});

	it("seeds a session-local goal for production /bg child jobs", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		let childGoalBeforePrompt: string | undefined;
		let childSessionManager: SessionManager | undefined;
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				createSessionManager: SessionManager.create,
				createSession: async (options) => {
					childSessionManager = options.sessionManager;
					return {
						session: {
							messages: [],
							prompt: async () => {
								childGoalBeforePrompt = childSessionManager?.getSessionGoalJson();
							},
						},
					};
				},
			}),
		});

		await harness.command("bg", "  Audit current test failures  ", {
			model: parentHarness.getModel(),
			modelRegistry: parentHarness.session.modelRegistry,
			sessionManager: parentHarness.sessionManager,
		});
		const [agent] = harness.store.listAgents();
		if (!agent) {
			throw new Error("expected background agent");
		}
		await waitForTerminalAgent(harness, agent.id);

		expect(JSON.parse(childGoalBeforePrompt ?? "{}")).toMatchObject({ objective: "Audit current test failures" });
	});

	it("rejects oversized /bg prompts without creating production child agents", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		const notifications: Array<{ level?: string; message: string }> = [];
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				createSessionManager: SessionManager.create,
				createSession: async () => {
					throw new Error("should not create a child session");
				},
			}),
		});

		await harness.command("bg", "x".repeat(4001), {
			model: parentHarness.getModel(),
			modelRegistry: parentHarness.session.modelRegistry,
			sessionManager: parentHarness.sessionManager,
			ui: { notify: (message, level) => notifications.push({ level, message }) },
		});

		expect(notifications).toEqual([{ level: "error", message: "Objective too long (4001 > 4000 chars)" }]);
		expect(harness.store.listAgents()).toEqual([]);
	});

	it("preserves the original prompt for custom dispatchers", async () => {
		let dispatchedPrompt: string | undefined;
		const dispatcher: ChildAgentDispatcher = async ({ prompt }) => {
			dispatchedPrompt = prompt;
			return { lifecycle: "completed" };
		};
		const harness = createMultiAgentHarness({ dispatcher });

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", { prompt: "  Preserve spacing  " });
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(dispatchedPrompt).toBe("  Preserve spacing  ");
	});

	it("preserves oversized prompts for store-only agents", async () => {
		const harness = createMultiAgentHarness();
		const prompt = "x".repeat(4001);

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", { prompt });

		expect(spawned.details).toMatchObject({ dispatched: false, prompt });
		expect(harness.store.listAgents()).toHaveLength(1);
	});

	it("rejects oversized prompts before creating production child agents", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				createSessionManager: SessionManager.create,
				createSession: async () => {
					throw new Error("should not create a child session");
				},
			}),
		});

		const spawned = await harness.call("spawn_agent", { prompt: "x".repeat(4001) });

		expect(spawned.content).toEqual([{ text: "spawn_agent prompt too long (4001 > 4000 chars)", type: "text" }]);
		expect(harness.store.listAgents()).toEqual([]);
	});

	it("rejects invalid direct production factory prompts before session creation", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		const store = new MultiAgentStore({ now: () => "2026-07-09T00:00:00.000Z" });
		const agent = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			permission: { narrowed: true, policy: "on-request" },
		}).agent;
		const createSession = vi.fn();
		const factory = createProductionChildAgentSessionFactory({
			createSessionManager: SessionManager.create,
			createSession,
		});

		await expect(
			factory({
				agent,
				ctx: {
					model: parentHarness.getModel(),
					modelRegistry: parentHarness.session.modelRegistry,
					sessionManager: parentHarness.sessionManager,
				} as unknown as ExtensionContext,
				prompt: " ",
			}),
		).rejects.toThrow("spawn_agent requires a non-empty prompt");
		expect(createSession).not.toHaveBeenCalled();
	});

	it("injects the seeded goal before the production child's first model turn", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		parentHarness.setResponses([fauxAssistantMessage("child done")]);
		let firstSystemPrompt: string | undefined;
		const captureFirstTurnSystemPrompt: ExtensionFactory = (pi) => {
			pi.on("before_agent_start", (event) => {
				firstSystemPrompt = (event as { systemPrompt?: string }).systemPrompt;
			});
		};
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				extensionFactories: [goalExtension, captureFirstTurnSystemPrompt],
				createSessionManager: SessionManager.create,
				createSession: async (options) => {
					const result = await createAgentSession({ ...options, authStorage: parentHarness.authStorage });
					return { session: result.session };
				},
			}),
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", { prompt: "Anchor first child turn" });
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(firstSystemPrompt).toContain("Long-running objective: Anchor first child turn");
	});

	it("rejects blank prompts before creating production child agents", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				createSessionManager: SessionManager.create,
				createSession: async () => {
					throw new Error("should not create a child session");
				},
			}),
		});

		const spawned = await harness.call("spawn_agent", { prompt: "  " });

		expect(spawned.content).toEqual([{ text: "spawn_agent requires a non-empty prompt", type: "text" }]);
		expect(harness.store.listAgents()).toEqual([]);
	});

	it("loads goal tools into production child sessions without mutating the parent goal", async () => {
		const parentHarness = await createHarness({ extensionFactories: [goalExtension] });
		childHarnesses.push(parentHarness);
		parentHarness.sessionManager.setSessionGoalJson(
			JSON.stringify({ objective: "parent objective", branch: "test", createdAt: "2026-01-01T00:00:00.000Z" }),
		);
		parentHarness.setResponses([
			fauxAssistantMessage(fauxToolCall("manage_goal", { action: "set", objective: "child objective" }), {
				stopReason: "toolUse",
			}),
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
