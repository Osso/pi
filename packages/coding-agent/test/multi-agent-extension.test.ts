import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import agentViewerExtension from "../extensions/agent-viewer/src/index.ts";
import agentsCoreExtension from "../extensions/agents-core/src/index.ts";
import {
	createHostrunMultiAgentRequestHandler,
	createMultiAgentRuntimeHandles,
	type ParentAgentJournalWriter,
	requestAgentSteering,
	resolveSelectedSessionMutationTarget,
} from "../extensions/agents-core/src/runtime.ts";
import agentsMailboxExtension from "../extensions/agents-mailbox/src/index.ts";
import effortExtension from "../extensions/effort/src/index.ts";
import goalExtension from "../extensions/goal/src/index.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createDetachedJobArtifacts } from "../src/core/detached-job-runner.ts";
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
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import {
	type AgentMailboxMessage,
	type AgentSnapshot,
	isActiveLifecycle,
	MultiAgentStore,
} from "../src/core/multi-agent-store.ts";
import { readProcessIdentity } from "../src/core/runtime-process.ts";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	createAgentSessionWithInternalOptions,
} from "../src/core/sdk.ts";
import {
	ENV_SELF_RESTART_OLD_PID,
	ENV_SELF_RESTART_PROMPT,
	ENV_SELF_RESTART_SESSION,
} from "../src/core/self-restart.ts";
import {
	createMultiAgentChildWithRuntimeOwnership,
	enqueueRuntimeMailboxMessage,
	getControlDbPath,
	listRuntimeMailboxMessages,
	readMultiAgentAgent,
	registerRuntimeMailboxListener,
	updateMultiAgentAgentTranscript,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";
import multiAgentExtension, {
	type AttachedSessionFactory,
	type ChildAgentSessionFactory,
	createProductionAttachedSessionFactory,
	createProductionChildAgentSessionFactory,
	type MultiAgentExtensionOptions,
} from "../src/extensions/multi-agent.ts";
import { main } from "../src/main.ts";
import { legacyMultiAgentStore } from "./helpers/legacy-multi-agent-store.ts";
import { CURRENT_PROCESS_IDENTITY, testProcessIdentity } from "./helpers/process-identity.ts";
import { forceRuntimeOwnership } from "./helpers/runtime-ownership.ts";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./suite/harness.ts";

const firstPartyGoalExtension: ExtensionFactory = (pi) => goalExtension(pi);
Object.defineProperty(firstPartyGoalExtension, "extensionPath", { value: "<first-party:goal>" });

const externalGoalExtension: ExtensionFactory = (pi) => goalExtension(pi);
Object.defineProperty(externalGoalExtension, "extensionPath", {
	value: join(process.cwd(), "test/multi-agent-extension.test.ts"),
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function completeAgent(store: MultiAgentStore, agent: AgentSnapshot): AgentSnapshot {
	const completed = legacyMultiAgentStore(store).transitionAgent(agent.id, agent.revision, "completed");
	expect(completed.ok).toBe(true);
	if (!completed.ok) throw new Error("expected completed transition");
	return completed.agent;
}

const managedTempDirs: string[] = [];
const ignoreRuntimeMailboxSignal = () => {};
process.on("SIGUSR2", ignoreRuntimeMailboxSignal);

afterAll(() => {
	process.off("SIGUSR2", ignoreRuntimeMailboxSignal);
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

type FauxChildOutcome =
	| { lifecycle: "completed"; result?: { summary?: string } }
	| { lifecycle: "failed" | "aborted"; error?: { message: string; code?: string } };

type FauxChildRun = (input: Parameters<ChildAgentSessionFactory>[0]) => Promise<FauxChildOutcome>;

function createTranscriptBackedFauxSessionFactory(run: FauxChildRun): ChildAgentSessionFactory {
	return async (input) => {
		const messages: ReturnType<typeof fauxAssistantMessage>[] = [];
		return {
			abort: () => {},
			messages,
			prompt: async () => {
				const outcome = await run(input);
				if (outcome.lifecycle === "completed") {
					if (outcome.result?.summary) messages.push(fauxAssistantMessage(outcome.result.summary));
					return;
				}
				throw new Error(outcome.error?.message ?? `Child ${outcome.lifecycle}`);
			},
			transcript: {
				path: join(tmpdir(), `${input.agent.id}.jsonl`),
				sessionId: `session-${input.agent.id}`,
			},
		};
	};
}

function createTestEntryWriter(sessionManager: SessionManager): ParentAgentJournalWriter {
	return {
		appendEntry: (customType: string, data?: unknown) => sessionManager.appendCustomEntry(customType, data),
	};
}

function ensureTranscriptBackedFactory(
	factory: ChildAgentSessionFactory | undefined,
): ChildAgentSessionFactory | undefined {
	if (!factory) return undefined;
	const wrapped: ChildAgentSessionFactory = async (input) => {
		const session = await factory(input);
		if (!session.transcript) {
			session.transcript = {
				path: join(tmpdir(), `${input.agent.id}.jsonl`),
				sessionId: `session-${input.agent.id}`,
			};
		}
		return session;
	};
	return Object.assign(wrapped, factory);
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
	agents?: AgentSnapshot[];
	messages?: AgentMailboxMessage[];
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

interface ContactParentDetails extends Record<string, unknown> {
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
	expect(result.details).toMatchObject({ message: { body, status: "pending" } });
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

function addDeadProcessOwner(store: MultiAgentStore, agentId: string) {
	const persistence = store.getPersistenceTarget();
	if (!persistence) throw new Error("expected persisted store fixture");
	const processIdentity = testProcessIdentity("dead-runtime");
	const acquired = forceRuntimeOwnership(persistence.controlDbPath, {
		agentId,
		nowIso: "2026-06-21T00:00:00.000Z",
		owner: { agentId: null, sessionId: persistence.sessionPath },
		processIdentity,
		sessionPath: persistence.sessionPath,
	});
	if (!acquired.ok) throw new Error(`failed to add dead process ownership: ${acquired.error}`);
	return { owner: { agentId: null, sessionId: persistence.sessionPath }, processIdentity };
}

function addActiveDispatchLease(store: MultiAgentStore, agentId: string, ownerSessionId: string): void {
	const persistence = store.getPersistenceTarget();
	if (!persistence) throw new Error("expected persisted store fixture");
	const acquired = forceRuntimeOwnership(persistence.controlDbPath, {
		agentId,
		nowIso: "2026-06-21T00:00:00.000Z",
		owner: { agentId: null, sessionId: ownerSessionId },
		processIdentity: CURRENT_PROCESS_IDENTITY,
		sessionPath: persistence.sessionPath,
	});
	if (!acquired.ok) throw new Error(`failed to add active process ownership: ${acquired.error}`);
	const transcript = { path: `/sessions/${agentId}.jsonl`, sessionId: `${agentId}-session` };
	const updated = updateMultiAgentAgentTranscript(
		persistence.controlDbPath,
		persistence.sessionPath,
		agentId,
		transcript,
		"2026-06-21T00:00:00.000Z",
	);
	if (!updated) throw new Error("failed to attach active process transcript");
	store.publishLifecycleCoordinatorSnapshot(updated);
	registerRuntimeMailboxListener(
		persistence.controlDbPath,
		{ agentId, sessionId: transcript.sessionId },
		process.pid,
		undefined,
		{ runtimeInstanceId: JSON.stringify(CURRENT_PROCESS_IDENTITY) },
	);
}

function spawnStoreFixture(
	store: MultiAgentStore,
	input: {
		agentType?: string;
		displayName?: string;
		parentId?: string;
		prompt: string;
	},
): AgentToolResult<SpawnAgentDetails> {
	const agent = legacyMultiAgentStore(store).spawnAgent({
		agentType: input.agentType?.trim() || "default",
		cwd: "/repo",
		displayName: input.displayName?.trim() || input.agentType?.trim() || "Agent",
		parentId: input.parentId,
		permission: { narrowed: true, policy: "on-request" },
	}).agent;
	return {
		content: [{ type: "text", text: `Fixture ${agent.displayName} (${agent.id})` }],
		details: { agent, dispatched: false, prompt: input.prompt },
	};
}

function createMultiAgentHarness(
	options: {
		appendEntry?: (customType: string, data?: unknown) => void;
		createAttachedSession?: AttachedSessionFactory;
		createChildSession?: ChildAgentSessionFactory;
		ctx?: Partial<ExtensionContext>;
		legacyDispatcher?: () => Promise<{ lifecycle: "completed" }>;
		runtimeHandles?: ReturnType<typeof createMultiAgentRuntimeHandles>;
		store?: MultiAgentStore;
	} = {},
) {
	const commands = new Map<string, RegisteredCommand>();
	const eventHandlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void | Promise<void>>>();
	const tools = new Map<string, RegisteredTool>();
	const store = options.store ?? new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
	const defaultSessionManager = store.getPersistenceTarget() ? undefined : createControlDbSession();
	if (defaultSessionManager) {
		store.setPersistenceSessionManager(defaultSessionManager);
	}
	let ctx: ExtensionContext;
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
		appendEntry(customType: string, data?: unknown) {
			if (options.appendEntry) options.appendEntry(customType, data);
			else (ctx.sessionManager as SessionManager).appendCustomEntry(customType, data);
		},
	} as unknown as ExtensionAPI;

	const extensionOptions = {
		createAttachedSession: options.createAttachedSession,
		createChildSession: ensureTranscriptBackedFactory(options.createChildSession),
		runtimeHandles: options.runtimeHandles,
		store,
		...(options.legacyDispatcher ? { dispatcher: options.legacyDispatcher } : {}),
	} as MultiAgentExtensionOptions;
	multiAgentExtension(pi, extensionOptions);

	ctx = {
		cwd: "/repo",
		hasUI: false,
		mode: "print",
		sessionManager: defaultSessionManager,
		...options.ctx,
	} as ExtensionContext;
	const persistence = store.getPersistenceTarget();
	if (persistence) {
		const supervisorSessionId = ctx.sessionManager?.getSessionId() ?? persistence.sessionPath;
		registerRuntimeMailboxListener(
			persistence.controlDbPath,
			{ agentId: null, sessionId: supervisorSessionId },
			CURRENT_PROCESS_IDENTITY.pid,
			persistence.sessionPath,
		);
	}

	return {
		getSessionId: () => ctx.sessionManager.getSessionId(),
		setAgentRuntimeIdentity: (agentId: string | undefined) => {
			ctx.multiAgentAgentId = agentId;
		},
		emit: async (eventName: string, event: unknown = {}) => {
			for (const handler of eventHandlers.get(eventName) ?? []) {
				await handler(event, ctx);
			}
		},
		call: async <TDetails extends Record<string, unknown>>(
			name: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
		) => {
			const tool = tools.get(name);
			if (!tool) {
				throw new Error(`tool not registered: ${name}`);
			}

			return (await tool.execute(`${name}-call`, params, signal, undefined, ctx)) as AgentToolResult<TDetails>;
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

async function waitForAgentLifecycle(
	harness: ReturnType<typeof createMultiAgentHarness>,
	agentId: string,
	lifecycle: AgentSnapshot["lifecycle"],
): Promise<AgentSnapshot> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const agent = harness.store.getAgent(agentId);
		if (agent?.lifecycle === lifecycle) return agent;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`Timed out waiting for ${agentId} to reach ${lifecycle}; current=${harness.store.getAgent(agentId)?.lifecycle ?? "missing"}`,
	);
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
	const childSessions: Harness["session"][] = [];

	afterEach(async () => {
		for (const session of childSessions.splice(0)) session.dispose();
		const completedHarnesses = childHarnesses.splice(0);
		for (const harness of completedHarnesses) harness.session.dispose();
		await delay(100);
		for (const harness of completedHarnesses) harness.cleanup();
	});

	it("registers spawn/list/cancel/steer/contact/viewer tools", () => {
		const harness = createMultiAgentHarness();

		expect([...harness.tools.keys()].sort()).toEqual([
			"agent_viewer",
			"attach_session_agent",
			"cancel_agent",
			"contact_parent",
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
			["agent_viewer", false],
			["attach_session_agent", false],
			["cancel_agent", false],
			["contact_parent", false],
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
			"agent_viewer",
			"attach_session_agent",
			"cancel_agent",
			"contact_parent",
			"list_agents",
			"send_agent_message",
			"spawn_agent",
			"steer_agent",
			"wait_agents",
		]);

		const spawned = spawnStoreFixture(harness.store, {
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
				status: "failed",
				toAgentId: attached.details.agent.id,
			});
			expect(sent.details.message).toMatchObject({
				fromAgentId: "main",
				status: "pending",
				toAgentId: attached.details.agent.id,
			});
			expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
				{
					body: "Mailbox request",
					recipient: { agentId: attached.details.agent.id, sessionId: savedSessionId },
				},
			]);
			// Dormant attachments have no runtime lease, so lifecycle steering fails
			// instead of claiming a pending turn. Plain mailbox delivery remains queued.
			expect(harness.store.listMailboxMessages()).toMatchObject([
				{ id: sent.details.message.id, status: "pending" },
			]);
			expect(cancelled.content).toEqual([
				{
					text: `Could not cancel ${attached.details.agent.id}: runtime ownership unavailable`,
					type: "text",
				},
			]);
			expect(cancelled.details.agent).toMatchObject({
				id: attached.details.agent.id,
				lifecycle: agentBeforeCancel.lifecycle,
			});
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("cancels prompted attached sessions through their exact process ownership", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-dispatch-attached-session-"));
		try {
			const savedSessionId = "019f29f4-0000-7000-8000-000000000003";
			const savedSession = SessionManager.create("/repo", tempDir, { id: savedSessionId });
			savedSession.appendMessage({ role: "user", content: "saved prompt", timestamp: 1 });
			savedSession.appendMessage(fauxAssistantMessage("saved response"));
			const childPrompt = deferred<void>();
			const abort = vi.fn(() => childPrompt.resolve(undefined));
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
			const running = await waitForAgentLifecycle(harness, attached.details.agent.id, "running");
			const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
				agentId: running.id,
				reason: "user requested",
			});

			expect(attached.details).toMatchObject({ dispatched: true, prompt: "Continue saved work" });
			expect(running).toMatchObject({ lifecycle: "running", transcript: { sessionId: savedSessionId } });
			expect(abort).toHaveBeenCalledOnce();
			expect(cancelled.content).toEqual([{ text: `Cancelled ${running.displayName}.`, type: "text" }]);
			expect(cancelled.details.agent).toMatchObject({ id: running.id, lifecycle: "aborted" });
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
				context: "fresh",
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

	it("terminalizes a real spawned child AgentSession thinking timeout as failed", async () => {
		let childHarness: Harness | undefined;
		const supervisorSession = createControlDbSession();
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		store.setPersistenceSessionManager(supervisorSession);
		const harness = createMultiAgentHarness({
			ctx: { sessionManager: supervisorSession },
			store,
			createChildSession: async ({ agent }) => {
				childHarness = await createHarness({
					thinkingPhaseTimeoutMs: 10,
					multiAgentAgentId: agent.id,
					multiAgentParentSessionId: supervisorSession.getSessionId(),
					multiAgentStore: store,
				});
				childHarnesses.push(childHarness);
				childHarness.setResponses([
					async () => {
						await delay(50);
						return fauxAssistantMessage("too late");
					},
				]);
				return childHarness.session;
			},
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Timed out worker",
			prompt: "start",
		});
		const waited = await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(childHarness).toBeDefined();
		expect(waited).toMatchObject({
			error: { message: "Child agent thinking phase exceeded 15 minutes" },
			lifecycle: "failed",
		});
	});

	it("does not register the supervisor lifecycle mirror in child runtimes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-child-lifecycle-mirror-"));
		try {
			const childSession = SessionManager.create("/repo", tempDir, {
				id: "019f29f4-0000-7000-8000-000000000107",
				isSubagent: true,
				parentSession: "parent-session",
			});
			const controlDbPath = getControlDbPath(tempDir);
			childSession.setMetadataControlDbPath(controlDbPath);
			const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			store.setPersistenceSessionManager(childSession);
			const childContext = {
				controlDbPath,
				multiAgentAgentId: "agent_child",
				multiAgentParentSessionId: "parent-session",
				multiAgentRuntimeRole: "child",
				sessionManager: childSession,
			} as unknown as ExtensionContext;
			const harness = createMultiAgentHarness({ ctx: childContext, store });
			await harness.emit("session_start", { reason: "startup", type: "session_start" });
			const hostrun = createHostrunMultiAgentRequestHandler({ store });
			await expect(hostrun({ method: "agents.list", params: {} }, childContext, undefined)).resolves.toBeDefined();
			const agent = legacyMultiAgentStore(store).spawnAgent({
				agentType: "background",
				cwd: "/repo",
				displayName: "Unrelated worker",
				permission: { narrowed: true, policy: "on-request" },
			}).agent;

			store.publishTerminalOutboxSnapshot({
				...agent,
				lifecycle: "completed",
				result: { summary: "finished elsewhere" },
				revision: agent.revision + 1,
			});

			expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
		} finally {
			rmSync(tempDir, { force: true, recursive: true });
		}
	});

	it("unsubscribes the runtime lifecycle mirror during extension reload", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-reload-lifecycle-mirror-"));
		try {
			const supervisorSession = SessionManager.create("/repo", tempDir, {
				id: "019f29f4-0000-7000-8000-000000000106",
			});
			const controlDbPath = getControlDbPath(tempDir);
			supervisorSession.setMetadataControlDbPath(controlDbPath);
			const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			store.setPersistenceSessionManager(supervisorSession);
			const harness = createMultiAgentHarness({
				ctx: { controlDbPath, sessionManager: supervisorSession },
				store,
			});
			await harness.emit("session_start", { reason: "startup", type: "session_start" });
			await harness.emit("session_shutdown", { reason: "reload", type: "session_shutdown" });
			const agent = legacyMultiAgentStore(store).spawnAgent({
				agentType: "background",
				cwd: "/repo",
				displayName: "Reload worker",
				permission: { narrowed: true, policy: "on-request" },
			}).agent;

			store.publishTerminalOutboxSnapshot({
				...agent,
				lifecycle: "completed",
				result: { summary: "finished after reload" },
				revision: agent.revision + 1,
			});

			expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
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
				const runtimeTable = db
					.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_mailbox_messages'")
					.get();
				const raw = db
					.prepare("SELECT session_path, message_id, data FROM multi_agent_mailbox_messages")
					.all() as Array<{ session_path: string; message_id: string; data: string }>;
				expect(runtimeTable).toBeUndefined();
				expect(raw).toHaveLength(1);
				expect(raw[0].session_path).toBe(supervisorSession.getSessionFile());
				expect(raw[0].message_id).toMatch(/^message_/);
				expect(JSON.parse(raw[0].data)).toMatchObject({
					body: `Session ${savedSessionId} completed: attached complete`,
					recipientSessionId: supervisorSessionId,
				});
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
		const interrupted = legacyMultiAgentStore(source).spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Recovered work",
			origin: "attached",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/recovered.jsonl", sessionId: "recovered-session" },
		});
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

	it("resumes a persisted running agent when its owning supervisor has no local runtime handle", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const persistence = source.getPersistenceTarget();
		if (!persistence) throw new Error("expected persisted store fixture");
		const coordinator = new LifecycleCoordinator({
			controlDbPath: persistence.controlDbPath,
			createAgentId: () => source.allocateAgentIdForLifecycleCoordinator(),
			now: () => "2026-06-21T00:00:00.000Z",
			processIdentity: CURRENT_PROCESS_IDENTITY,
			sessionPath: persistence.sessionPath,
		});
		const prepared = coordinator.prepareChild({
			agentType: "implement",
			cwd: "/repo",
			displayName: "Missing runtime",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/missing-runtime.jsonl", sessionId: "missing-runtime-session" },
		});
		const created = coordinator.commitRunningChild(prepared, persistence.sessionPath);
		expect(created.ok).toBe(true);
		if (!created.ok) throw new Error("expected running child");
		source.publishLifecycleCoordinatorSnapshot(created.agent);
		const prompts: string[] = [];
		const store = MultiAgentStore.fromSessionManager(session, { now: () => "2026-06-21T00:00:01.000Z" });
		const harness = createMultiAgentHarness({
			createAttachedSession: async ({ agent }) => ({
				messages: [fauxAssistantMessage("resumed")],
				prompt: async (prompt) => {
					prompts.push(prompt);
				},
				transcript: agent.transcript,
			}),
			store,
		});

		await harness.emit("session_start", { reason: "resume", type: "session_start" });
		await waitForTerminalAgent(harness, created.agent.id);

		expect(prompts).toEqual([expect.stringContaining("Continue the conversation")]);
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
			const replacementAgent = legacyMultiAgentStore(replacementStore).spawnAgent({
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
				lifecycle: "running",
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

	it("leaves an unjournaled agent untouched while its exact owner is live", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const unjournaled = legacyMultiAgentStore(source).spawnAgent({
			agentType: "reviewer",
			cwd: "/repo",
			displayName: "Live unjournaled child",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/live-unjournaled.jsonl", sessionId: "live-unjournaled" },
		});
		const persistence = source.getPersistenceTarget();
		if (!persistence) throw new Error("Expected persistence target");
		forceRuntimeOwnership(persistence.controlDbPath, {
			agentId: unjournaled.agent.id,
			owner: { agentId: null, sessionId: session.getSessionId() },
			processIdentity: CURRENT_PROCESS_IDENTITY,
			sessionPath: persistence.sessionPath,
		});
		const store = MultiAgentStore.fromSessionManager(session);
		const createAttachedSession = vi.fn<AttachedSessionFactory>();
		const harness = createMultiAgentHarness({ createAttachedSession, ctx: { sessionManager: session }, store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });

		expect(store.getAgent(unjournaled.agent.id)).toMatchObject({ lifecycle: "running", revision: 1 });
		expect(createAttachedSession).not.toHaveBeenCalled();
	});

	it("resumes steering-pending agents from persisted transcripts regardless of origin", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = legacyMultiAgentStore(source).spawnAgent({
			agentType: "implement",
			cwd: "/repo",
			displayName: "Spawned child",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/spawned-child.jsonl", sessionId: "spawned-child-session" },
		});
		const liveRuntime = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		await once(liveRuntime, "spawn");
		if (liveRuntime.pid === undefined) throw new Error("Spawned child runtime has no PID");
		const persistence = source.getPersistenceTarget();
		if (!persistence) throw new Error("Expected persisted recovery test store");
		const liveOwnership = forceRuntimeOwnership(persistence.controlDbPath, {
			agentId: interrupted.agent.id,
			owner: { agentId: null, sessionId: persistence.sessionPath },
			processIdentity: readProcessIdentity(liveRuntime.pid),
			sessionPath: persistence.sessionPath,
		});
		if (!liveOwnership.ok) throw new Error(`Could not add live test ownership: ${liveOwnership.error}`);
		try {
			const steering = legacyMultiAgentStore(source).sendSteering(interrupted.agent.id, interrupted.agent.revision, {
				body: "Continue after recovery",
				fromAgentId: "main",
				targetCheckpoint: "next_model_call",
			});
			expect(steering.ok).toBe(true);
		} finally {
			liveRuntime.kill();
			await once(liveRuntime, "exit");
		}
		addDeadProcessOwner(source, interrupted.agent.id);
		const store = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});
		const prompts: string[] = [];
		const createAttachedSession: AttachedSessionFactory = async ({ agent, sessionPath }) => {
			expect(agent.id).toBe(interrupted.agent.id);
			expect(sessionPath).toBe("/sessions/spawned-child.jsonl");
			return {
				messages: [fauxAssistantMessage("spawned recovery complete")],
				prompt: async (prompt) => {
					prompts.push(prompt);
				},
				transcript: agent.transcript,
			};
		};
		const harness = createMultiAgentHarness({ createAttachedSession, store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });
		const recovered = await waitForTerminalAgent(harness, interrupted.agent.id);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("Continue the conversation from where it left off");
		expect(recovered).toMatchObject({
			lifecycle: "completed",
			result: { summary: "spawned recovery complete" },
			transcript: { path: "/sessions/spawned-child.jsonl", sessionId: "spawned-child-session" },
		});
	});

	it("keeps recovered agents waiting when no session runtime is configured", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = legacyMultiAgentStore(source).spawnAgent({
			agentType: "explore",
			cwd: "/repo",
			displayName: "Waiting child",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/waiting-child.jsonl", sessionId: "waiting-child-session" },
		});
		const waiting = legacyMultiAgentStore(source).transitionAgent(
			interrupted.agent.id,
			interrupted.agent.revision,
			"waiting_for_input",
		);
		expect(waiting.ok).toBe(true);
		addDeadProcessOwner(source, interrupted.agent.id);
		const store = MultiAgentStore.fromSessionManager(session, {
			now: () => "2026-06-21T00:00:00.000Z",
		});
		const harness = createMultiAgentHarness({ store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });
		await delay(20);

		expect(store.getAgent(interrupted.agent.id)).toMatchObject({
			error: undefined,
			lifecycle: "waiting_for_input",
		});
		expect(store.getActiveAgentCount()).toBe(1);
	});

	it("waits for active background jobs that update store state without a dispatch", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const harness = createMultiAgentHarness({ store });
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "background",
			cwd: "/repo",
			displayName: "Background tool",
			permission: { narrowed: true, policy: "on-request" },
			worker: { adapter: "runtime", handleId: "live-background-job" },
		});
		const running = { ok: true as const, agent: spawned.agent };

		const waited = harness.call<WaitAgentsDetails>("wait_agents", {});
		expect(await resolvesWithin(waited, 10)).toBe(false);

		const current = store.getAgent(running.agent.id);
		expect(current).toBeDefined();
		if (!current) throw new Error("expected current background job");
		expect(
			legacyMultiAgentStore(store).transitionAgent(current.id, current.revision, "completed", {
				result: { summary: "done" },
			}).ok,
		).toBe(true);

		const result = await waited;
		expectWaitCompletionMessage(result, "Background tool completed: done");
		expect(store.getAgent(running.agent.id)).toMatchObject({
			id: running.agent.id,
			lifecycle: "completed",
			result: { summary: "done" },
		});
	});

	it("cancels a Hostrun wait for detached background agents", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		legacyMultiAgentStore(source).spawnAgent({
			agentType: "background",
			cwd: "/repo",
			displayName: "Detached background tool",
			permission: { narrowed: true, policy: "on-request" },
			worker: { adapter: "subprocess", handleId: "stale-process" },
		});
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

	it("fails spawned agents without a transcript after their owner process exits", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = legacyMultiAgentStore(source).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "No transcript",
			permission: { narrowed: true, policy: "on-request" },
		});
		addDeadProcessOwner(source, interrupted.agent.id);
		const store = MultiAgentStore.fromSessionManager(session, { now: () => "2026-06-21T00:00:00.000Z" });
		const harness = createMultiAgentHarness({ store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });
		await delay(20);

		expect(store.getAgent(interrupted.agent.id)).toMatchObject({
			error: { code: "lost_runtime" },
			lifecycle: "failed",
		});
	});

	it("recovers dead-owned descendants before their parent", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const parent = legacyMultiAgentStore(source).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Dead parent",
			permission: { narrowed: true, policy: "on-request" },
		});
		const child = legacyMultiAgentStore(source).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Dead child",
			parentId: parent.agent.id,
			permission: { inheritedFrom: parent.agent.id, narrowed: true, policy: "on-request" },
		});
		addDeadProcessOwner(source, parent.agent.id);
		addDeadProcessOwner(source, child.agent.id);
		const store = MultiAgentStore.fromSessionManager(session, { now: () => "2026-06-21T00:00:00.000Z" });
		const harness = createMultiAgentHarness({ store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });
		await delay(20);

		expect(store.getAgent(child.agent.id)).toMatchObject({ error: { code: "lost_runtime" }, lifecycle: "failed" });
		expect(store.getAgent(parent.agent.id)).toMatchObject({ error: { code: "lost_runtime" }, lifecycle: "failed" });
	});

	it("marks a detached runner failed when it dies before committing terminal state", async () => {
		const artifactRoot = mkdtempSync(join(tmpdir(), "pi-detached-recovery-"));
		try {
			const session = createControlDbSession();
			const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			source.setPersistenceSessionManager(session);
			const persistence = source.getPersistenceTarget();
			if (!persistence) throw new Error("expected persisted store fixture");
			const agentId = source.allocateAgentIdForLifecycleCoordinator();
			const artifacts = createDetachedJobArtifacts(artifactRoot, agentId);
			writeFileSync(artifacts.outputPath, "completed output\n");
			const processIdentity = testProcessIdentity("dead-detached-runner");
			const owner = { agentId: null, sessionId: persistence.sessionPath };
			const coordinator = new LifecycleCoordinator({
				controlDbPath: persistence.controlDbPath,
				createAgentId: () => source.allocateAgentIdForLifecycleCoordinator(),
				now: () => "2026-06-21T00:00:00.000Z",
				processIdentity,
				sessionPath: persistence.sessionPath,
			});
			const prepared = coordinator.prepareChild({
				agentId,
				agentType: "background",
				cwd: "/repo",
				displayName: "Pyrun evaluation",
				permission: { narrowed: true, policy: "on-request" },
				result: { fileRefs: [{ label: "Pyrun output", path: artifacts.outputPath }] },
			});
			const created = coordinator.commitRunningChild(prepared, owner.sessionId);
			expect(created.ok).toBe(true);
			if (!created.ok) throw new Error("expected child ownership");
			source.publishLifecycleCoordinatorSnapshot(created.agent);
			const store = MultiAgentStore.fromSessionManager(session, { now: () => "2026-06-21T00:00:02.000Z" });
			const harness = createMultiAgentHarness({ store });

			await harness.emit("session_start", { reason: "resume", type: "session_start" });
			await delay(20);

			expect(store.getAgent(agentId)).toMatchObject({
				error: { code: "lost_runtime" },
				lifecycle: "failed",
			});
		} finally {
			rmSync(artifactRoot, { force: true, recursive: true });
		}
	});

	it("settles cancelling spawned agents as aborted after their owner process exits", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const cancelled = legacyMultiAgentStore(source).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Cancel pending",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/cancelling.jsonl", sessionId: "cancelling-session" },
		});
		expect(
			legacyMultiAgentStore(source).transitionAgent(cancelled.agent.id, cancelled.agent.revision, "cancelling").ok,
		).toBe(true);
		addDeadProcessOwner(source, cancelled.agent.id);
		const store = MultiAgentStore.fromSessionManager(session, { now: () => "2026-06-21T00:00:00.000Z" });
		const createAttachedSession = vi.fn<AttachedSessionFactory>();
		const harness = createMultiAgentHarness({ createAttachedSession, store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });
		// Dead-owner recovery honors the recorded cancellation intent: a cancelling
		// agent settles as aborted instead of failed/lost_runtime.
		const aborted = await waitForAgentLifecycle(harness, cancelled.agent.id, "aborted");

		expect(createAttachedSession).not.toHaveBeenCalled();
		expect(aborted).toMatchObject({
			lifecycle: "aborted",
			error: { code: "lost_runtime" },
		});
	});

	it("does not restart attached agents that were already waiting before restore", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const idle = legacyMultiAgentStore(store).spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Idle work",
			origin: "attached",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/idle.jsonl", sessionId: "idle-session" },
		});
		const waiting = legacyMultiAgentStore(store).transitionAgent(
			idle.agent.id,
			idle.agent.revision,
			"waiting_for_input",
		);
		expect(waiting.ok).toBe(true);
		const createAttachedSession = vi.fn<AttachedSessionFactory>();
		const harness = createMultiAgentHarness({ createAttachedSession, store });

		await harness.emit("session_start", { reason: "resume", type: "session_start" });

		expect(createAttachedSession).not.toHaveBeenCalled();
		expect(store.getAgent(idle.agent.id)).toMatchObject({ lifecycle: "waiting_for_input" });
	});

	it("does not recover agents outside a child runtime's direct descendants", async () => {
		const session = createControlDbSession();
		const source = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		source.setPersistenceSessionManager(session);
		const interrupted = legacyMultiAgentStore(source).spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Recovered work",
			origin: "attached",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/recovered.jsonl", sessionId: "recovered-session" },
		});
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
		const interrupted = legacyMultiAgentStore(source).spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Recovered work",
			origin: "attached",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/sessions/recovered.jsonl", sessionId: "recovered-session" },
		});
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

	it("terminalizes a real attached child AgentSession thinking timeout as failed", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-timeout-attached-session-"));
		try {
			const savedSessionId = "019f29f4-0000-7000-8000-000000000016";
			const savedSession = SessionManager.create("/repo", tempDir, { id: savedSessionId });
			savedSession.appendMessage({ role: "user", content: "saved prompt", timestamp: 1 });
			savedSession.appendMessage(fauxAssistantMessage("saved response"));
			const supervisorSession = createControlDbSession();
			const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
			store.setPersistenceSessionManager(supervisorSession);
			const harness = createMultiAgentHarness({
				ctx: { sessionManager: supervisorSession },
				store,
				createAttachedSession: async ({ agent }) => {
					const childHarness = await createHarness({
						thinkingPhaseTimeoutMs: 10,
						multiAgentAgentId: agent.id,
						multiAgentParentSessionId: supervisorSession.getSessionId(),
						multiAgentStore: store,
					});
					childHarnesses.push(childHarness);
					childHarness.setResponses([
						async () => {
							await delay(50);
							return fauxAssistantMessage("too late");
						},
					]);
					return childHarness.session;
				},
			});

			const attached = await harness.call<AttachSessionAgentDetails>("attach_session_agent", {
				path: savedSession.getSessionFile(),
				prompt: "Continue saved work",
			});
			const waited = await waitForTerminalAgent(harness, attached.details.agent.id);

			expect(waited).toMatchObject({
				error: { message: "Child agent thinking phase exceeded 15 minutes" },
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
			"attach_session_agent",
			"cancel_agent",
			"list_agents",
			"spawn_agent",
			"steer_agent",
			"wait_agents",
		]);
		expect(collectTools((pi) => agentViewerExtension(pi, { store }))).toEqual(["agent_viewer"]);
		expect(collectTools((pi) => agentsMailboxExtension(pi, { store }))).toEqual([
			"contact_parent",
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

	it("bounds /bg cancellation when abort does not acknowledge exit", async () => {
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
		expect(harness.store.getAgent(agent.id)).toMatchObject({ lifecycle: "cancelling" });
	});

	it("keeps cancellation pending when the child abort handler throws", async () => {
		const childPrompt = deferred<void>();
		const createChildSession: ChildAgentSessionFactory = async () => ({
			abort: () => {
				throw new Error("abort failed");
			},
			messages: [],
			prompt: async () => childPrompt.promise,
		});
		const harness = createMultiAgentHarness({ createChildSession });
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Worker",
			prompt: "sleep 100",
		});
		await Promise.resolve();

		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: spawned.details.agent.id,
			reason: "user requested",
		});

		expect(cancelled.details.agent).toMatchObject({ lifecycle: "cancelling" });
		expect(harness.store.getAgent(spawned.details.agent.id)).toMatchObject({ lifecycle: "cancelling" });
	});

	it("bounds spawn_agent cancellation when abort does not acknowledge exit", async () => {
		const abort = vi.fn();
		const childPrompt = deferred<void>();
		const createChildSession: ChildAgentSessionFactory = async () => ({
			abort,
			messages: [],
			prompt: async () => childPrompt.promise,
		});
		const harness = createMultiAgentHarness({ createChildSession });

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
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
		expect(harness.store.getAgent(current.id)).toMatchObject({ lifecycle: "cancelling" });
	});

	it("cascades cancellation through active descendants before terminalizing the parent", async () => {
		const rejectPromptByAgent = new Map<string, (error: Error) => void>();
		const abortOrder: string[] = [];
		const harness = createMultiAgentHarness({
			createChildSession: async ({ agent }) => {
				const prompt = new Promise<void>((_resolve, reject) => rejectPromptByAgent.set(agent.id, reject));
				return {
					abort: () => {
						abortOrder.push(agent.id);
						rejectPromptByAgent.get(agent.id)?.(new Error("aborted"));
					},
					messages: [],
					prompt: async () => prompt,
				};
			},
		});
		const parent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Parent",
			prompt: "parent",
		});
		const child = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Child",
			parentId: parent.details.agent.id,
			prompt: "child",
		});
		await Promise.resolve();

		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: parent.details.agent.id,
			reason: "cascade",
		});

		expect(abortOrder).toEqual([child.details.agent.id, parent.details.agent.id]);
		expect(harness.store.getAgent(child.details.agent.id)).toMatchObject({ lifecycle: "aborted" });
		expect(cancelled.details.agent).toMatchObject({ lifecycle: "aborted" });
	});

	it("bounds parent cancellation when a slow descendant ignores abort", async () => {
		const rejectPromptByAgent = new Map<string, (error: Error) => void>();
		let slowChildAgentId: string | undefined;
		const harness = createMultiAgentHarness({
			createChildSession: async ({ agent }) => {
				const prompt = new Promise<void>((_resolve, reject) => rejectPromptByAgent.set(agent.id, reject));
				return {
					abort: () => {
						if (agent.id === slowChildAgentId) return;
						rejectPromptByAgent.get(agent.id)?.(new Error("parent aborted"));
					},
					messages: [],
					prompt: async () => prompt,
				};
			},
		});
		const parent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Slow parent",
			prompt: "parent",
		});
		const child = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Slow child",
			parentId: parent.details.agent.id,
			prompt: "child",
		});
		slowChildAgentId = child.details.agent.id;
		await Promise.resolve();

		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: parent.details.agent.id,
			reason: "cascade",
		});

		expect(harness.store.getAgent(child.details.agent.id)).toMatchObject({ lifecycle: "cancelling" });
		expect(harness.store.getAgent(parent.details.agent.id)).toMatchObject({ lifecycle: "cancelling" });
		expect(cancelled.details.agent).toMatchObject({ lifecycle: "cancelling" });
	}, 12_000);

	it("terminalizes cancellation only after the child runtime exits", async () => {
		let rejectPrompt: (error: Error) => void = () => {};
		const prompt = new Promise<void>((_resolve, reject) => {
			rejectPrompt = reject;
		});
		const harness = createMultiAgentHarness({
			createChildSession: async () => ({
				abort: () => rejectPrompt(new Error("aborted")),
				messages: [],
				prompt: async () => prompt,
			}),
		});
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Worker",
			prompt: "sleep",
		});
		await Promise.resolve();

		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: spawned.details.agent.id,
			reason: "user requested",
		});

		expect(cancelled.details.agent).toMatchObject({ lifecycle: "aborted" });
	});

	it("routes Hostrun agents.select through the interactive view callback when available", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			permission: { narrowed: true, policy: "on-request" },
		});
		const selectAgentView = vi.fn((agentId: string) => store.selectActiveAgentTarget(agentId) !== undefined);
		const handler = createHostrunMultiAgentRequestHandler({ selectAgentView, store });
		const ctx = { cwd: "/repo", hasUI: false, mode: "print" } as ExtensionContext;

		const result = await handler({ method: "agents.select", params: { agentId: spawned.agent.id } }, ctx, undefined);

		expect(selectAgentView).toHaveBeenCalledWith(spawned.agent.id);
		expect(result).toMatchObject({ agent: { id: spawned.agent.id, displayName: "Worker" } });
	});

	it("resolves main after a bridge-selected child view returns to main", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			permission: { narrowed: true, policy: "on-request" },
		});
		store.selectActiveAgentTarget(spawned.agent.id);
		store.clearSelectedAgentView();

		expect(resolveSelectedSessionMutationTarget(store, runtimeHandles)).toBeUndefined();
	});

	it("rejects a selected live session without viewed model capabilities", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			permission: { narrowed: true, policy: "on-request" },
		});
		store.selectActiveAgentTarget(spawned.agent.id);
		runtimeHandles.sessions.set(spawned.agent.id, {
			messages: [],
			prompt: async () => {},
			model: undefined,
			thinkingLevel: "medium",
			setModel: async () => {},
			setThinkingLevel: () => {},
		} as never);

		expect(() => resolveSelectedSessionMutationTarget(store, runtimeHandles)).toThrow(
			`Agent ${spawned.agent.id} does not support live session mutation`,
		);
	});

	it("rejects a selected active row without a live session handle persistently", () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			permission: { narrowed: true, policy: "on-request" },
		});
		store.selectActiveAgentTarget(spawned.agent.id);

		expect(() => resolveSelectedSessionMutationTarget(store, runtimeHandles)).toThrow(
			`Agent ${spawned.agent.id} is not a live child session`,
		);
		expect(() => resolveSelectedSessionMutationTarget(store, runtimeHandles)).toThrow(
			`Agent ${spawned.agent.id} is not a live child session`,
		);
	});

	it("leaves the current mutation view unchanged when Hostrun agents.select fails", async () => {
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			permission: { narrowed: true, policy: "on-request" },
		});
		const handler = createHostrunMultiAgentRequestHandler({
			runtimeHandles,
			selectAgentView: () => false,
			store,
		});
		const ctx = { cwd: "/repo", hasUI: false, mode: "print" } as ExtensionContext;

		await expect(
			handler({ method: "agents.select", params: { agentId: spawned.agent.id } }, ctx, undefined),
		).rejects.toThrow(`Agent view selection failed: ${spawned.agent.id}`);
		expect(store.getSelectedAgentId()).toBeUndefined();
		expect(resolveSelectedSessionMutationTarget(store, runtimeHandles)).toBeUndefined();
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
			["spawn_agent", { context: "fresh", displayName: "Nested", prompt: "do work" }],
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
			{ method: "agents.spawn", params: { context: "fresh", displayName: "Nested", prompt: "do work" } },
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
		const sessionManager = createControlDbSession();
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		store.setPersistenceSessionManager(sessionManager);
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const createChildSession = createTranscriptBackedFauxSessionFactory(async () => {
			await finishGate.promise;
			return { lifecycle: "completed", result: { summary: "hostrun done" } };
		});
		const handler = createHostrunMultiAgentRequestHandler(
			{ createChildSession, runtimeHandles, store },
			createTestEntryWriter(sessionManager),
		);
		const harness = createMultiAgentHarness({
			createChildSession,
			ctx: { sessionManager },
			runtimeHandles,
			store,
		});
		const ctx = { cwd: "/repo", hasUI: false, mode: "print", sessionManager } as unknown as ExtensionContext;

		const spawned = (await handler(
			{ method: "agents.spawn", params: { context: "fresh", displayName: "Worker", prompt: "hostrun work" } },
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

	it("aborts Hostrun-spawned child sessions when exit acknowledgement times out", async () => {
		const abort = vi.fn();
		const childPrompt = deferred<void>();
		const sessionManager = createControlDbSession();
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		store.setPersistenceSessionManager(sessionManager);
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const createChildSession: ChildAgentSessionFactory = async ({ agent }) => ({
			abort,
			messages: [],
			prompt: async () => childPrompt.promise,
			transcript: { path: join(tmpdir(), `${agent.id}.jsonl`), sessionId: `session-${agent.id}` },
		});
		const handler = createHostrunMultiAgentRequestHandler(
			{ createChildSession, runtimeHandles, store },
			createTestEntryWriter(sessionManager),
		);
		const harness = createMultiAgentHarness({
			createChildSession,
			ctx: { sessionManager },
			runtimeHandles,
			store,
		});
		const ctx = { cwd: "/repo", hasUI: false, mode: "print", sessionManager } as unknown as ExtensionContext;

		const spawned = (await handler(
			{ method: "agents.spawn", params: { context: "fresh", displayName: "Worker", prompt: "hostrun work" } },
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
		expect(cancelled.details.agent).toMatchObject({ id: spawned.agent.id, lifecycle: "cancelling" });
		expect(store.getAgent(spawned.agent.id)).toMatchObject({ id: spawned.agent.id, lifecycle: "cancelling" });
	});

	it("persists a spawned child as running only after session construction succeeds", async () => {
		const factoryGate = deferred<void>();
		const promptGate = deferred<void>();
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const createChildSession: ChildAgentSessionFactory = async () => {
			await factoryGate.promise;
			return { messages: [], prompt: async () => promptGate.promise };
		};
		const harness = createMultiAgentHarness({ createChildSession, store });

		const spawnPromise = harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Worker",
			prompt: "production work",
		});
		await delay(1);
		expect(store.listAgents()).toEqual([]);

		factoryGate.resolve();
		const spawned = await spawnPromise;
		expect(store.getAgent(spawned.details.agent.id)).toMatchObject({ lifecycle: "running", revision: 1 });
		promptGate.resolve();
	});

	it("cancels after child transcript metadata attaches without caller revision", async () => {
		const childPrompt = deferred<void>();
		const createChildSession: ChildAgentSessionFactory = async () => ({
			messages: [],
			prompt: async () => childPrompt.promise,
			transcript: { path: "/tmp/sessions/child.jsonl", sessionId: "child-session" },
		});
		const harness = createMultiAgentHarness({ createChildSession });

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
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
			lifecycle: "cancelling",
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

		expect(cancelled.details.agent).toMatchObject({ id: agent.id, lifecycle: "cancelling" });
		expect(abort).toHaveBeenCalledTimes(1);
		expect(harness.store.getAgent(agent.id)).toMatchObject({ lifecycle: "cancelling" });
	});

	it("lists only background jobs in /jobs", async () => {
		const notifications: string[] = [];
		const harness = createMultiAgentHarness();

		await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
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

	it("does not execute a legacy dispatcher without a transcript-backed child session", async () => {
		const legacyDispatcher = vi.fn(async () => ({ lifecycle: "completed" as const }));
		const harness = createMultiAgentHarness({ legacyDispatcher });

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Legacy worker",
			prompt: "run legacy path",
		});

		expect(spawned.content[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(/no child session runtime/i),
		});
		expect(spawned.details.dispatched).toBe(false);
		expect(legacyDispatcher).not.toHaveBeenCalled();
		expect(harness.store.listAgents()).toEqual([]);
	});

	it("rejects spawn before persistence when no executable runtime is configured", async () => {
		const harness = createMultiAgentHarness();
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			agentType: "scout",
			displayName: "Scout",
			prompt: "Inspect auth",
		});
		expect(spawned.content[0]).toMatchObject({
			type: "text",
			text: expect.stringMatching(/no child session runtime/i),
		});
		expect(spawned.details.dispatched).toBe(false);
		expect(harness.store.listAgents()).toEqual([]);
	});

	it("renders only active listed-agent identities in visible content", async () => {
		const harness = createMultiAgentHarness();
		const active = spawnStoreFixture(harness.store, {
			displayName: "Active Scout",
			agentType: "explore",
			prompt: "Inspect active work",
		});
		const completed = spawnStoreFixture(harness.store, {
			displayName: "Finished Worker",
			agentType: "implement",
			prompt: "Inspect finished work",
		});
		completeAgent(harness.store, completed.details.agent);

		const listed = await harness.call<ListAgentsDetails>("list_agents", {});
		const content = listed.content[0];
		if (!content || content.type !== "text") {
			throw new Error("expected visible text content");
		}

		expect(content.text).toContain(
			`id=${active.details.agent.id} name="Active Scout" type=explore status=active lifecycle=running`,
		);
		expect(content.text).not.toContain(completed.details.agent.id);
	});

	it("exposes no option for listing terminal agents", () => {
		const harness = createMultiAgentHarness();
		const parameters = harness.tools.get("list_agents")?.parameters as {
			additionalProperties?: unknown;
			properties?: Record<string, unknown>;
		};

		expect(parameters.properties).not.toHaveProperty("activeOnly");
		expect(parameters.additionalProperties).toBe(false);
	});

	it("always excludes terminal agents", async () => {
		const harness = createMultiAgentHarness();
		const active = spawnStoreFixture(harness.store, {
			displayName: "Active",
			prompt: "Active task",
		});
		const completed = spawnStoreFixture(harness.store, {
			displayName: "Completed",
			prompt: "Completed task",
		});
		const terminal = completeAgent(harness.store, completed.details.agent);

		const listed = await harness.call<ListAgentsDetails>("list_agents", {});

		expect(terminal.lifecycle).toBe("completed");
		expect(listed.details.agents.map((agent) => agent.id)).toEqual([active.details.agent.id]);
	});

	it("lists descendants for a parent without TUI state", async () => {
		const harness = createMultiAgentHarness();
		const parent = spawnStoreFixture(harness.store, { displayName: "Parent", prompt: "Parent task" });
		const child = spawnStoreFixture(harness.store, {
			displayName: "Child",
			parentId: parent.details.agent.id,
			prompt: "Child task",
		});
		spawnStoreFixture(harness.store, { displayName: "Sibling", prompt: "Sibling task" });

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
		const agent = legacyMultiAgentStore(supervisorStore).spawnAgent({
			agentType: "verifier",
			cwd: "/repo",
			displayName: "Verifier",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: "/tmp/sessions/verifier.jsonl", sessionId: "child-session" },
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
			transcript: { agentId: agent.agent.id, path: "/tmp/sessions/verifier.jsonl", sessionId: "child-session" },
		});
	});

	it("views one agent without lifecycle mutation", async () => {
		const harness = createMultiAgentHarness();
		const parent = spawnStoreFixture(harness.store, { displayName: "Parent", prompt: "Parent task" });
		const child = spawnStoreFixture(harness.store, {
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
			agent: { id: child.details.agent.id, lifecycle: "running", revision: pinned.agent.revision },
			children: [],
			parentId: parent.details.agent.id,
			status: {
				agentId: child.details.agent.id,
				lifecycle: "running",
				revision: pinned.agent.revision,
				terminal: false,
			},
		});
		expect(afterView).toMatchObject({
			id: child.details.agent.id,
			lifecycle: "running",
			revision: pinned.agent.revision,
		});
	});

	it("exposes read-only status transcript and command descriptors in agent_viewer", async () => {
		const harness = createMultiAgentHarness();
		const parent = legacyMultiAgentStore(harness.store).spawnAgent({
			agentType: "lead",
			cwd: "/repo",
			displayName: "Lead",
			parentId: "root",
			permission: { narrowed: true, policy: "on-request" },
		});
		const child = legacyMultiAgentStore(harness.store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: parent.agent.id,
			permission: { inheritedFrom: parent.agent.id, narrowed: true, policy: "on-request" },
			transcript: { path: "/tmp/sessions/child.jsonl", sessionId: "child-session" },
		});
		const running = { ok: true as const, agent: child.agent };

		const viewed = await harness.call<AgentViewerDetails>("agent_viewer", { agentId: child.agent.id });

		expect(viewed.details).toMatchObject({
			agent: { id: child.agent.id, lifecycle: "running", revision: running.agent.revision },
			children: [],
			parentId: parent.agent.id,
			status: { agentId: child.agent.id, lifecycle: "running", revision: running.agent.revision, terminal: false },
			transcript: { agentId: child.agent.id, path: "/tmp/sessions/child.jsonl", sessionId: "child-session" },
		});
		expect(viewed.details.commands).toEqual(
			expect.arrayContaining([
				{ agentId: child.agent.id, command: "stop", tool: "cancel_agent" },
				{ agentId: child.agent.id, command: "steer", tool: "steer_agent" },
			]),
		);
		expect(harness.store.getAgent(child.agent.id)).toMatchObject({
			id: child.agent.id,
			lifecycle: "running",
			revision: running.agent.revision,
		});
	});

	it("renders terminal summary and error details in agent_viewer visible content", async () => {
		const harness = createMultiAgentHarness();
		const completed = legacyMultiAgentStore(harness.store).spawnAgent({
			agentType: "implement",
			cwd: "/repo",
			displayName: "Completed Worker",
			permission: { narrowed: true, policy: "on-request" },
		});
		const failed = legacyMultiAgentStore(harness.store).spawnAgent({
			agentType: "verifier",
			cwd: "/repo",
			displayName: "Failed Verifier",
			permission: { narrowed: true, policy: "on-request" },
		});
		const completedResult = legacyMultiAgentStore(harness.store).transitionAgent(
			completed.agent.id,
			completed.agent.revision,
			"completed",
			{
				result: { summary: "Implementation finished" },
			},
		);
		expect(completedResult.ok).toBe(true);
		const failedResult = legacyMultiAgentStore(harness.store).transitionAgent(
			failed.agent.id,
			failed.agent.revision,
			"failed",
			{
				error: { message: "Verification failed", code: "VERIFY_FAILED" },
			},
		);
		expect(failedResult.ok).toBe(true);

		const viewedCompleted = await harness.call<AgentViewerDetails>("agent_viewer", { agentId: completed.agent.id });
		const viewedFailed = await harness.call<AgentViewerDetails>("agent_viewer", { agentId: failed.agent.id });
		const completedContent = viewedCompleted.content[0];
		const failedContent = viewedFailed.content[0];
		if (!completedContent || completedContent.type !== "text" || !failedContent || failedContent.type !== "text") {
			throw new Error("expected visible text content");
		}

		expect(completedContent.text).toContain(`status=terminal lifecycle=completed\nSummary: Implementation finished`);
		expect(failedContent.text).toContain(
			`status=terminal lifecycle=failed\nError: Verification failed (VERIFY_FAILED)`,
		);
	});

	it("projects mailbox inbox, outbox, and acknowledgements without mutating state", async () => {
		const harness = createMultiAgentHarness();
		const parent = spawnStoreFixture(harness.store, {
			displayName: "Parent",
			parentId: "main",
			prompt: "Parent task",
		});
		const child = spawnStoreFixture(harness.store, {
			displayName: "Child",
			parentId: parent.details.agent.id,
			prompt: "Child task",
		});
		const running = { ok: true as const, agent: parent.details.agent };
		addActiveDispatchLease(harness.store, running.agent.id, harness.getSessionId());
		const steered = await harness.call<SteerAgentDetails>("steer_agent", {
			agentId: parent.details.agent.id,
			expectedRevision: running.agent.revision,
			message: "Check auth",
		});
		const accepted = legacyMultiAgentStore(harness.store).ackSteering(
			parent.details.agent.id,
			steered.details.agent.revision,
			steered.details.message.id,
			"accepted",
		);
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) {
			throw new Error("expected steering acknowledgement");
		}
		harness.setAgentRuntimeIdentity(child.details.agent.id);
		const contact = await harness.call<ContactParentDetails>("contact_parent", {
			agentId: child.details.agent.id,
			expectedRevision: accepted.agent.revision,
			message: "Need scope",
		});

		const childMailbox = mailboxDetails(harness.store, child.details.agent.id);
		const parentMailbox = mailboxDetails(harness.store, parent.details.agent.id);
		const childAfterMailbox = harness.store.getAgent(child.details.agent.id);

		expect(childMailbox.acknowledgements).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: contact.details.message.id, status: "failed" })]),
		);
		expect(childMailbox.inbox).toEqual([]);
		expect(childMailbox.outbox).toMatchObject([
			{ id: contact.details.message.id, toAgentId: parent.details.agent.id, status: "failed" },
		]);
		expect(childMailbox.pendingCount).toBe(0);
		expect(parentMailbox).toMatchObject({
			inbox: expect.arrayContaining([
				expect.objectContaining({ id: steered.details.message.id, fromAgentId: "supervisor", status: "accepted" }),
				expect.objectContaining({
					id: contact.details.message.id,
					fromAgentId: child.details.agent.id,
					status: "failed",
				}),
			]),
			pendingCount: 0,
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
			const parent = spawnStoreFixture(harness.store, { displayName: "Parent", prompt: "Parent task" });
			const child = spawnStoreFixture(harness.store, {
				displayName: "Child",
				parentId: parent.details.agent.id,
				prompt: "Child task",
			});
			const sibling = spawnStoreFixture(harness.store, { displayName: "Sibling", prompt: "Sibling task" });
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
				status: "failed",
				toAgentId: child.details.agent.id,
			});
			expect(childMailbox.inbox).toMatchObject([
				{ id: sent.details.message.id, status: "failed", toAgentId: child.details.agent.id },
			]);
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
		const child = spawnStoreFixture(harness.store, {
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
			status: "failed",
			toAgentId: child.details.agent.id,
		});
		expect(childMailbox.inbox).toMatchObject([
			{ id: sent.details.message.id, status: "failed", toAgentId: child.details.agent.id },
		]);
	});

	it("lets a child contact its parent without choosing a sibling target", async () => {
		const harness = createMultiAgentHarness();
		const parent = spawnStoreFixture(harness.store, { displayName: "Parent", prompt: "Parent task" });
		const child = spawnStoreFixture(harness.store, {
			displayName: "Child",
			parentId: parent.details.agent.id,
			prompt: "Child task",
		});
		spawnStoreFixture(harness.store, { displayName: "Sibling", prompt: "Sibling task" });
		harness.setAgentRuntimeIdentity(child.details.agent.id);

		const contact = await harness.call<ContactParentDetails>("contact_parent", {
			agentId: child.details.agent.id,
			expectedRevision: child.details.agent.revision,
			message: "Need auth scope",
		});

		expect(contact.details.agent).toMatchObject({
			id: child.details.agent.id,
			lastActivity: { description: "Contacted parent" },
			revision: child.details.agent.revision,
		});
		expect(contact.details.message).toMatchObject({
			body: "Need auth scope",
			fromAgentId: child.details.agent.id,
			kind: "parent_request",
			status: "failed",
			toAgentId: parent.details.agent.id,
		});
	});

	it("rejects contact_parent when the caller has no agent runtime identity", async () => {
		const harness = createMultiAgentHarness();
		const child = spawnStoreFixture(harness.store, {
			displayName: "Child",
			parentId: "parent",
			prompt: "Child task",
		});

		const contact = await harness.call<ContactParentDetails>("contact_parent", {
			agentId: child.details.agent.id,
			message: "Need auth scope",
		});

		expect(contact.content).toEqual([
			{ type: "text", text: expect.stringContaining("runtime identity is unavailable") },
		]);
		expect(contact.details.message).toMatchObject({
			fromAgentId: child.details.agent.id,
			kind: "parent_request",
			status: "failed",
			toAgentId: "",
		});
		expect(harness.store.listMailboxMessages()).toEqual([]);
	});

	it("routes persisted detached Pyrun cancellation through exact-owner runtime mailbox control", async () => {
		const harness = createMultiAgentHarness();
		const persistence = harness.store.getPersistenceTarget();
		if (!persistence) throw new Error("expected persisted store fixture");
		const agentId = harness.store.allocateAgentIdForLifecycleCoordinator();
		const coordinator = new LifecycleCoordinator({
			controlDbPath: persistence.controlDbPath,
			createAgentId: () => harness.store.allocateAgentIdForLifecycleCoordinator(),
			now: () => "2026-07-12T00:00:00.000Z",
			processIdentity: testProcessIdentity("detached-pyrun-cancel"),
			sessionPath: persistence.sessionPath,
		});
		const prepared = coordinator.prepareChild({
			agentId,
			agentType: "background",
			cwd: "/repo",
			displayName: "Pyrun evaluation",
			permission: { narrowed: true, policy: "on-request" },
			result: { fileRefs: [{ label: "Pyrun output", path: "/tmp/pyrun-output.log" }] },
			worker: { adapter: "runtime", cwd: "/repo", handleId: "123" },
		});
		const created = coordinator.commitRunningChild(prepared, persistence.sessionPath);
		expect(created.ok).toBe(true);
		if (!created.ok) throw new Error("expected child ownership");
		harness.store.publishLifecycleCoordinatorSnapshot(created.agent);

		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId,
			reason: "stop evaluation",
		});

		expect(cancelled.details.agent).toMatchObject({ id: agentId, lifecycle: "cancelling" });
		const [message] = listRuntimeMailboxMessages(persistence.controlDbPath);
		expect(JSON.parse(message?.body ?? "")).toMatchObject({
			command: "cancel",
			identity: { jobId: agentId, outputLabel: "Pyrun output" },
			reason: "stop evaluation",
		});
	});

	it("rejects cancellation for rows without runtime ownership", async () => {
		const harness = createMultiAgentHarness();
		const spawned = spawnStoreFixture(harness.store, {
			displayName: "Worker",
			prompt: "Implement tests",
		});
		const agent = spawned.details.agent;

		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: agent.id,
			reason: "user stopped it",
		});

		expect(cancelled.content).toEqual([
			{ text: `Could not cancel ${agent.id}: runtime ownership unavailable`, type: "text" },
		]);
		expect(cancelled.details.agent).toMatchObject({ id: agent.id, lifecycle: "running", revision: agent.revision });
		expect(cancelled.details.reason).toBe("user stopped it");
	});

	it("wait_agents returns immediately when no agents are active", async () => {
		const harness = createMultiAgentHarness();

		const waited = await harness.call<WaitAgentsDetails>("wait_agents", {});

		expect(waited).toEqual({ content: [], details: {} });
	});

	it("steers a running agent with mailbox acknowledgement state", async () => {
		const harness = createMultiAgentHarness();
		const spawned = spawnStoreFixture(harness.store, {
			displayName: "Reviewer",
			parentId: "main",
			prompt: "Review auth",
		});
		const agent = spawned.details.agent;
		const started = { ok: true as const, agent };
		addActiveDispatchLease(harness.store, agent.id, harness.getSessionId());

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

	it("reports unavailable ownership when steering targets a dead exact owner", () => {
		const harness = createMultiAgentHarness();
		const spawned = spawnStoreFixture(harness.store, {
			displayName: "Dead reviewer",
			parentId: "main",
			prompt: "Review auth",
		});
		addDeadProcessOwner(harness.store, spawned.details.agent.id);
		const persistence = harness.store.getPersistenceTarget();
		if (!persistence) throw new Error("Expected persisted multi-agent test store");

		const steered = requestAgentSteering(
			harness.store,
			{ agentId: spawned.details.agent.id, message: "Conclude now" },
			{
				actorAgentId: null,
				controlDbPath: persistence.controlDbPath,
				sessionId: persistence.sessionPath,
			},
		);

		expect(steered).toMatchObject({
			error: `Could not steer ${spawned.details.agent.id}: runtime ownership unavailable`,
			ok: false,
		});
	});

	it("rejects a stale sender session after runtime replacement", () => {
		const harness = createMultiAgentHarness();
		const spawned = spawnStoreFixture(harness.store, {
			displayName: "Reviewer",
			parentId: "main",
			prompt: "Review auth",
		});
		const agent = spawned.details.agent;
		addActiveDispatchLease(harness.store, agent.id, harness.getSessionId());
		const persistence = harness.store.getPersistenceTarget();
		if (!persistence) throw new Error("Expected persisted multi-agent test store");

		const stale = requestAgentSteering(
			harness.store,
			{ agentId: agent.id, message: "Use stale session" },
			{
				actorAgentId: null,
				controlDbPath: persistence.controlDbPath,
				sessionId: "replaced-session",
			},
		);

		expect(stale).toMatchObject({ ok: false, error: `Could not steer ${agent.id}: runtime ownership unavailable` });
		expect(harness.store.getAgent(agent.id)).toMatchObject({ lifecycle: "running", revision: 1 });
		expect(harness.store.listMailboxMessages()).toEqual([]);
	});

	it("rejects steering a descendant that is not the caller's direct child", async () => {
		const harness = createMultiAgentHarness();
		const parent = spawnStoreFixture(harness.store, {
			displayName: "Parent",
			parentId: "main",
			prompt: "Parent task",
		});
		const child = spawnStoreFixture(harness.store, {
			displayName: "Grandchild",
			parentId: parent.details.agent.id,
			prompt: "Child task",
		});
		addActiveDispatchLease(harness.store, child.details.agent.id, harness.getSessionId());

		const steered = await harness.call<SteerAgentDetails>("steer_agent", {
			agentId: child.details.agent.id,
			message: "Wrong scope",
		});

		expect(steered.content).toEqual([
			{ text: `Could not steer ${child.details.agent.id}: mutation_mismatch`, type: "text" },
		]);
		expect(harness.store.getAgent(child.details.agent.id)).toMatchObject({ lifecycle: "running", revision: 1 });
		expect(harness.store.listMailboxMessages()).toEqual([]);
	});

	it("aborts a child session signal when its agent is cancelled", async () => {
		const dispatchStarted = deferred<void>();
		let childSignal: AbortSignal | undefined;
		const createChildSession = createTranscriptBackedFauxSessionFactory(async ({ signal }) => {
			if (!signal) throw new Error("Expected child session abort signal");
			childSignal = signal;
			dispatchStarted.resolve(undefined);
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return { lifecycle: "aborted", error: { message: "child aborted" } };
		});
		const harness = createMultiAgentHarness({ createChildSession });
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Dispatcher",
			prompt: "wait",
		});
		await dispatchStarted.promise;

		const cancelled = await harness.call<CancelAgentDetails>("cancel_agent", {
			agentId: spawned.details.agent.id,
			reason: "stop child session",
		});

		expect(childSignal?.aborted).toBe(true);
		expect(cancelled.details.agent).toMatchObject({ lifecycle: "aborted" });
	});

	it("returns from spawn_agent before the child session settles", async () => {
		const dispatchGate = deferred<void>();
		const createChildSession = createTranscriptBackedFauxSessionFactory(async () => {
			await dispatchGate.promise;
			return { lifecycle: "completed", result: { summary: "done" } };
		});
		const harness = createMultiAgentHarness({ createChildSession });

		const spawnPromise = harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Worker",
			prompt: "Implement auth tests",
		});
		const didResolveBeforeDispatch = await resolvesWithin(spawnPromise, 20);
		dispatchGate.resolve(undefined);
		const spawned = await spawnPromise;

		expect(didResolveBeforeDispatch).toBe(true);
		expect(spawned.details).toMatchObject({ dispatched: true });
	});

	it("retains exact process ownership until terminal settlement", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-11T20:00:00.000Z"));
		try {
			const finishGate = deferred<void>();
			const createChildSession = createTranscriptBackedFauxSessionFactory(async () => {
				await finishGate.promise;
				return { lifecycle: "completed", result: { summary: "renewed" } };
			});
			const harness = createMultiAgentHarness({ createChildSession });
			const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
				context: "fresh",
				displayName: "Long worker",
				prompt: "Run until terminal settlement",
			});

			await vi.advanceTimersByTimeAsync(40_000);
			finishGate.resolve(undefined);
			for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();

			expect(harness.store.getAgent(spawned.details.agent.id)).toMatchObject({
				lifecycle: "completed",
				result: { summary: "renewed" },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("terminalizes a completed parent after its active child becomes terminal", async () => {
		const parentGate = deferred<void>();
		const childGate = deferred<void>();
		const createChildSession = createTranscriptBackedFauxSessionFactory(async ({ agent }) => {
			await (agent.displayName === "Parent" ? parentGate.promise : childGate.promise);
			return { lifecycle: "completed", result: { summary: `${agent.displayName} done` } };
		});
		const harness = createMultiAgentHarness({ createChildSession });
		const parent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Parent",
			prompt: "parent",
		});
		const child = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Child",
			parentId: parent.details.agent.id,
			prompt: "child",
		});

		parentGate.resolve();
		await delay(20);
		expect(harness.store.getAgent(parent.details.agent.id)).toMatchObject({ lifecycle: "running" });

		childGate.resolve();
		await waitForTerminalAgent(harness, child.details.agent.id);
		const completedParent = await waitForTerminalAgent(harness, parent.details.agent.id);
		expect(completedParent).toMatchObject({ lifecycle: "completed", result: { summary: "Parent done" } });
	});

	it("wait_agents drains every terminal notification already waiting in the mailbox", async () => {
		const finishGate = deferred<void>();
		const createChildSession = createTranscriptBackedFauxSessionFactory(async ({ agent }) => {
			await finishGate.promise;
			return { lifecycle: "completed", result: { summary: `${agent.displayName} done` } };
		});
		const harness = createMultiAgentHarness({ createChildSession });
		const first = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "First",
			prompt: "First task",
		});
		const second = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Second",
			prompt: "Second task",
		});

		finishGate.resolve(undefined);
		await Promise.all([
			waitForAgentLifecycle(harness, first.details.agent.id, "completed"),
			waitForAgentLifecycle(harness, second.details.agent.id, "completed"),
		]);
		const waited = await harness.call<WaitAgentsDetails>("wait_agents", {});

		expect(waited.content).toEqual([
			{ text: "First completed: First done\nSecond completed: Second done", type: "text" },
		]);
		expect(waited.details.agents?.map((agent) => agent.id)).toEqual([
			first.details.agent.id,
			second.details.agent.id,
		]);
		expect(waited.details.messages).toHaveLength(2);
		expect(waited.details.messages?.every((message) => message.status === "pending")).toBe(true);
		expect(harness.store.listMailboxMessages().every((message) => message.status === "delivered")).toBe(true);
	});

	it("reconciles a dead detached child so its live parent can complete", async () => {
		const parentPromptStarted = deferred<void>();
		const releaseParent = deferred<void>();
		const createChildSession = createTranscriptBackedFauxSessionFactory(async ({ agent }) => {
			if (agent.displayName === "Parent") {
				parentPromptStarted.resolve();
				await releaseParent.promise;
			}
			return { lifecycle: "completed", result: { summary: `${agent.displayName} done` } };
		});
		const harness = createMultiAgentHarness({ createChildSession });
		const parent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Parent",
			prompt: "parent",
		});
		await parentPromptStarted.promise;

		const persistence = harness.store.getPersistenceTarget();
		if (!persistence) throw new Error("expected persisted store fixture");
		const deadWorker = testProcessIdentity("live-parent-dead-detached-child");
		const created = createMultiAgentChildWithRuntimeOwnership(persistence.controlDbPath, {
			agent: {
				agentType: "background",
				createdAt: "2026-07-18T12:00:00.000Z",
				cwd: "/repo",
				detached: true,
				displayName: "Pyrun evaluation",
				id: "pyrun_dead",
				lifecycle: "running",
				parentId: parent.details.agent.id,
				permission: parent.details.agent.permission,
				revision: 1,
				updatedAt: "2026-07-18T12:00:00.000Z",
				worker: { adapter: "runtime", handleId: String(deadWorker.pid), toolCallId: "tool_dead" },
			},
			agentId: "pyrun_dead",
			nowIso: "2026-07-18T12:00:00.000Z",
			owner: { agentId: parent.details.agent.id, sessionId: harness.getSessionId() },
			processIdentity: deadWorker,
			sessionPath: persistence.sessionPath,
		});
		if (!created.ok) throw new Error(`Could not create detached child: ${created.error}`);
		harness.store.publishLifecycleCoordinatorSnapshot(created.agent as AgentSnapshot);

		const waitAbort = new AbortController();
		const waitPromise = harness.call<WaitAgentsDetails>("wait_agents", {}, waitAbort.signal);
		const didResolve = await resolvesWithin(waitPromise, 250);
		if (!didResolve) waitAbort.abort();
		expect(didResolve).toBe(true);
		const waited = await waitPromise;
		expect(waited.details).toMatchObject({
			agent: { id: "pyrun_dead", lifecycle: "failed", error: { code: "lost_runtime" } },
		});
		expect(harness.store.getAgent(parent.details.agent.id)).toMatchObject({ lifecycle: "running" });

		releaseParent.resolve();
		const completedParent = await waitForTerminalAgent(harness, parent.details.agent.id);
		expect(readMultiAgentAgent(persistence.controlDbPath, persistence.sessionPath, "pyrun_dead")).toMatchObject({
			error: { code: "lost_runtime" },
			lifecycle: "failed",
		});
		expect(completedParent).toMatchObject({ lifecycle: "completed", result: { summary: "Parent done" } });
	});
	it("wait_agents returns when any active agent reaches a terminal state", async () => {
		const firstGate = deferred<void>();
		const secondGate = deferred<void>();
		const createChildSession = createTranscriptBackedFauxSessionFactory(async ({ agent }) => {
			await (agent.displayName === "First" ? firstGate.promise : secondGate.promise);
			return { lifecycle: "completed", result: { summary: `${agent.displayName} done` } };
		});
		const harness = createMultiAgentHarness({ createChildSession });
		const first = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "First",
			prompt: "First task",
		});
		const second = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
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
		const createChildSession: ChildAgentSessionFactory = async ({ agent }) => ({
			messages: [fauxAssistantMessage("child done")],
			prompt: async () => childPrompt.promise,
			transcript: { path: join(tmpdir(), `${agent.id}.jsonl`), sessionId: `session-${agent.id}` },
		});
		const harness = await createHarness({
			extensionFactories: [(pi) => multiAgentExtension(pi, { createChildSession, store })],
			multiAgentStore: store,
			persistedSession: true,
		});
		childHarnesses.push(harness);
		store.setPersistenceSessionManager(harness.sessionManager);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", { context: "fresh", displayName: "Worker", prompt: "child work" }),
				{ stopReason: "toolUse" },
			),
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
			[
				"From:",
				"- session: session-agent_1",
				"- agent: agent_1",
				"",
				"Message:",
				"Worker completed: child done",
			].join("\n"),
		]);
		expect(getAssistantTexts(harness)).toContain("parent idle");
		expect(getAssistantTexts(harness)).toContain("parent woke");
		expect(store.listMailboxMessages()).toMatchObject([{ status: "delivered" }]);
	});

	it("includes mailbox file references in the runtime mailbox follow-up", async () => {
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
		const child = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
		});
		const contacted = store.contactParent(child.agent.id, {
			fileRefs: [{ label: "Test log", path: "/tmp/test.log" }],
			body: "Review log",
		});
		if (!contacted.ok) throw new Error("expected parent contact");
		harness.setResponses([fauxAssistantMessage("initial reply"), fauxAssistantMessage("mailbox reply")]);
		enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "parent_request",
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
		expect(followUp).toContain("Attached files:\n- Test log — /tmp/test.log");
		expect(store.listMailboxMessages()).toMatchObject([{ id: contacted.message.id, status: "delivered" }]);
	});

	it("lets simultaneous waiters observe completion while late waits return immediately", async () => {
		const finishGate = deferred<void>();
		const createChildSession = createTranscriptBackedFauxSessionFactory(async () => {
			await finishGate.promise;
			return { lifecycle: "completed", result: { summary: "fan-out done" } };
		});
		const harness = createMultiAgentHarness({ createChildSession });
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Worker",
			prompt: "Complete for every waiter",
		});
		const first = harness.call<WaitAgentsDetails>("wait_agents", {});
		const second = harness.call<WaitAgentsDetails>("wait_agents", {});
		finishGate.resolve(undefined);
		const [firstResult, secondResult] = await Promise.all([first, second]);
		const lateResult = await harness.call<WaitAgentsDetails>("wait_agents", {});

		const completedWaits = [firstResult, secondResult].filter((waited) => waited.details.message !== undefined);
		const statusWaits = [firstResult, secondResult].filter((waited) => waited.details.message === undefined);
		expect(completedWaits).toHaveLength(1);
		expect(completedWaits[0]?.content).toEqual([{ text: "Worker completed: fan-out done", type: "text" }]);
		expect(completedWaits[0]?.details).toMatchObject({
			agent: { id: spawned.details.agent.id, lifecycle: "completed", revision: 2 },
			message: { status: "pending" },
		});
		expect(statusWaits).toHaveLength(1);
		expect(statusWaits[0]?.content).toEqual([{ text: "Worker is completed: fan-out done", type: "text" }]);
		expect(lateResult.content).toEqual([]);
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
		const parent = legacyMultiAgentStore(store).spawnAgent({
			agentType: "lead",
			cwd: "/repo",
			displayName: "Lead",
			permission: { narrowed: true, policy: "on-request" },
		});
		const createChildSession: ChildAgentSessionFactory = async ({ agent }) => {
			const messages: ReturnType<typeof fauxAssistantMessage>[] = [];
			return {
				messages,
				prompt: async () => {
					await idleGate.promise;
					const current = store.getAgent(agent.id) ?? agent;
					const waiting = legacyMultiAgentStore(store).transitionAgent(
						current.id,
						current.revision,
						"waiting_for_input",
					);
					expect(waiting.ok).toBe(true);
					idleState.resolve(undefined);
					await finishGate.promise;
					messages.push(fauxAssistantMessage("done"));
				},
				transcript: { path: join(tmpdir(), `${agent.id}.jsonl`), sessionId: `session-${agent.id}` },
			};
		};
		const harness = createMultiAgentHarness({
			createChildSession,
			ctx: { controlDbPath, sessionManager: session },
			store,
		});
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
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
			body: "Worker completed: done",
			fromAgentId: spawned.details.agent.id,
			kind: "system",
			status: "pending",
			toAgentId: parent.agent.id,
		});
		expect(store.getAgent(spawned.details.agent.id)).toMatchObject({
			id: spawned.details.agent.id,
			lifecycle: "completed",
			result: { summary: "done" },
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
		const spawned = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			permission: { narrowed: true, policy: "on-request" },
		});
		const running = { ok: true as const, agent: spawned.agent };
		const waiting = legacyMultiAgentStore(store).transitionAgent(
			running.agent.id,
			running.agent.revision,
			"waiting_for_input",
		);
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
		const completed = legacyMultiAgentStore(store).transitionAgent(
			waiting.agent.id,
			waiting.agent.revision,
			"completed",
			{
				result: { summary: "done" },
			},
		);
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

	it("dispatches a real child runner behind spawn_agent without TUI coupling", async () => {
		const dispatched: Array<{ agent: AgentSnapshot; prompt: string; mode: string; hasUI: boolean }> = [];
		const createChildSession = createTranscriptBackedFauxSessionFactory(async ({ agent, ctx, prompt }) => {
			dispatched.push({ agent, hasUI: ctx.hasUI, mode: ctx.mode, prompt });
			return { lifecycle: "completed", result: { summary: "done" } };
		});
		const harness = createMultiAgentHarness({ createChildSession });

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
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
		const createChildSession = createTranscriptBackedFauxSessionFactory(async () => ({
			lifecycle: "completed",
			result: { summary: "Committed 18125d44 feat: add local deploy script" },
		}));
		const harness = createMultiAgentHarness({ createChildSession });

		await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "commit workflow",
			prompt: "Commit current changes",
		});
		const waited = await harness.call<Record<string, unknown>>("wait_agents", {});

		expectWaitCompletionMessage(
			waited,
			"commit workflow completed: Committed 18125d44 feat: add local deploy script",
		);
	});

	it("returns failed wait_agents notifications from transcript-backed sessions", async () => {
		const createChildSession = createTranscriptBackedFauxSessionFactory(async () => ({
			lifecycle: "failed",
			error: { message: "Pyrun evaluation failed." },
		}));
		const harness = createMultiAgentHarness({ createChildSession });

		await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "failing workflow",
			prompt: "Run the failing job",
		});
		const waited = await harness.call<WaitAgentsDetails>("wait_agents", {});

		expect(waited.content).toEqual([{ text: "failing workflow failed: Pyrun evaluation failed.", type: "text" }]);
		expect(waited.details).toMatchObject({
			message: {
				body: "failing workflow failed: Pyrun evaluation failed.",
				status: "pending",
			},
		});
	});

	it("fails without dispatch when parent journal persistence fails", async () => {
		const prompt = vi.fn(async () => {});
		const dispose = vi.fn();
		const harness = createMultiAgentHarness({
			appendEntry: () => {
				throw new Error("journal disk full");
			},
			createChildSession: async ({ agent }) => ({
				dispose,
				messages: [],
				prompt,
				transcript: { path: `/sessions/${agent.id}.jsonl`, sessionId: `session-${agent.id}` },
			}),
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			prompt: "Review without journal",
		});

		expect(spawned.content).toEqual([
			{ text: "spawn_agent failed to persist parent journal: journal disk full", type: "text" },
		]);
		expect(spawned.details.agent).toMatchObject({
			error: { code: "parent_journal_failed", message: "journal disk full" },
			lifecycle: "failed",
		});
		expect(prompt).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("persists a child directly as failed when runtime construction throws", async () => {
		const harness = createMultiAgentHarness({
			createChildSession: async () => {
				throw new Error("factory unavailable");
			},
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Broken child",
			prompt: "run",
		});
		const terminal = await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(terminal).toMatchObject({ lifecycle: "failed", revision: 1 });
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
			context: "fresh",
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

	it("drains steering queued as a spawned child turn finishes before completing the child", async () => {
		let releasePrompt: (() => void) | undefined;
		const promptBlocked = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		let drainCalls = 0;
		const harness = createMultiAgentHarness({
			createChildSession: async ({ agent }) => {
				const childSessionId = `${agent.id}-session`;
				const persistence = harness.store.getPersistenceTarget();
				if (!persistence) throw new Error("expected persisted child store");
				registerRuntimeMailboxListener(
					persistence.controlDbPath,
					{ agentId: agent.id, sessionId: childSessionId },
					process.pid,
					undefined,
					{ runtimeInstanceId: JSON.stringify(CURRENT_PROCESS_IDENTITY) },
				);
				return {
					messages: [],
					prompt: async () => promptBlocked,
					drainRuntimeCoordination: async () => {
						drainCalls += 1;
						const message = harness.store
							.listMailboxMessages()
							.find((candidate) => candidate.kind === "steer" && candidate.toAgentId === agent.id);
						if (!message) throw new Error("expected pending steering message");
						const current = harness.store.getAgent(agent.id);
						if (!current) throw new Error("expected active child agent");
						const delivered = legacyMultiAgentStore(harness.store).ackSteering(
							agent.id,
							current.revision,
							message.id,
							"delivered",
						);
						if (!delivered.ok) throw new Error(`expected steering delivery: ${delivered.error}`);
					},
					transcript: { path: `/sessions/${agent.id}.jsonl`, sessionId: childSessionId },
				};
			},
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Steered Worker",
			prompt: "Initial work",
		});
		await harness.call<SteerAgentDetails>("steer_agent", {
			agentId: spawned.details.agent.id,
			message: "Check final blockers",
			targetCheckpoint: "next_model_call",
		});
		releasePrompt?.();
		const waited = await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(drainCalls).toBe(1);
		expect(waited.lifecycle).toBe("completed");
		expect(harness.store.listMailboxMessages()).toEqual([
			expect.objectContaining({ body: "Check final blockers", status: "delivered" }),
			expect.objectContaining({ kind: "system", status: "delivered" }),
		]);
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
			context: "fresh",
			agentType: "worker",
			displayName: "Worker",
			prompt: "Implement auth tests",
		});
		const waited = await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(sessionOptions).toMatchObject({
			cwd: "/repo",
			excludeTools: [
				"agent_viewer",
				"attach_session_agent",
				"cancel_agent",
				"list_agents",
				"spawn_agent",
				"steer_agent",
				"wait_agents",
				"manage_goal",
			],
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

	it("creates an explicitly fresh child with only its appended assignment", async () => {
		const parentHarness = await createHarness({ persistedSession: true });
		childHarnesses.push(parentHarness);
		parentHarness.sessionManager.appendMessage({
			role: "user",
			content: "Parent-only context marker",
			timestamp: 1,
		});
		parentHarness.sessionManager.appendMessage(fauxAssistantMessage("Parent-only assistant marker"));
		const parentMessagesBefore = parentHarness.sessionManager.buildSessionContext().messages;
		let receivedContext: unknown;
		let childSessionManager: SessionManager | undefined;
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const productionFactory = createProductionChildAgentSessionFactory({
			createSessionManager: SessionManager.create,
			multiAgentStore: store,
			createSession: async (options) => {
				childSessionManager = options.sessionManager;
				return {
					session: {
						bindExtensions: async () => {},
						get messages() {
							return options.sessionManager?.buildSessionContext().messages ?? [];
						},
						prompt: async (prompt) => {
							options.sessionManager?.appendMessage({ role: "user", content: prompt, timestamp: 2 });
							options.sessionManager?.appendMessage(fauxAssistantMessage("fresh child done"));
						},
					},
				};
			},
		});
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			store,
			createChildSession: async (input) => {
				receivedContext = "context" in input ? input.context : undefined;
				return productionFactory(input);
			},
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			prompt: "Handle isolated task",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(receivedContext).toBe("fresh");
		expect(childSessionManager?.buildSessionContext().messages.map(getMessageText)).toEqual([
			"Handle isolated task",
			"fresh child done",
		]);
		expect(childSessionManager?.getSessionId()).not.toBe(parentHarness.sessionManager.getSessionId());
		expect(childSessionManager?.getSessionFile()).not.toBe(parentHarness.sessionManager.getSessionFile());
		expect(parentHarness.sessionManager.buildSessionContext().messages).toEqual(parentMessagesBefore);
	});

	it("inherits the parent prompt prefix before appending the child assignment", async () => {
		const parentHarness = await createHarness({ persistedSession: true });
		childHarnesses.push(parentHarness);
		parentHarness.sessionManager.appendMessage({
			role: "user",
			content: "Inherited parent context marker",
			timestamp: 1,
		});
		parentHarness.sessionManager.appendMessage(fauxAssistantMessage("Inherited parent assistant marker"));
		parentHarness.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall(
					"spawn_agent",
					{ context: "inherit", prompt: "Continue integrated task" },
					{ id: "spawn_agent-call" },
				),
				{ stopReason: "toolUse" },
			),
		);
		const parentMessagesBefore = parentHarness.sessionManager.buildSessionContext().messages;
		let receivedContext: unknown;
		let childSessionManager: SessionManager | undefined;
		let childSessionOptions: CreateAgentSessionOptions | undefined;
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const productionFactory = createProductionChildAgentSessionFactory({
			createSessionManager: SessionManager.create,
			multiAgentStore: store,
			createSession: async (options) => {
				childSessionOptions = options;
				childSessionManager = options.sessionManager;
				return {
					session: {
						bindExtensions: async () => {},
						get messages() {
							return options.sessionManager?.buildSessionContext().messages ?? [];
						},
						prompt: async (prompt) => {
							options.sessionManager?.appendMessage({ role: "user", content: prompt, timestamp: 2 });
							options.sessionManager?.appendMessage(fauxAssistantMessage("inherited child done"));
						},
					},
				};
			},
		});
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			store,
			createChildSession: async (input) => {
				receivedContext = "context" in input ? input.context : undefined;
				return productionFactory(input);
			},
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "inherit",
			prompt: "Continue integrated task",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(receivedContext).toBe("inherit");
		expect(childSessionManager?.buildSessionContext().messages.map(getMessageText)).toEqual([
			"Inherited parent context marker",
			"Inherited parent assistant marker",
			"Continue integrated task",
			"inherited child done",
		]);
		expect(childSessionOptions).toMatchObject({
			excludeTools: [
				"agent_viewer",
				"attach_session_agent",
				"cancel_agent",
				"list_agents",
				"spawn_agent",
				"steer_agent",
				"wait_agents",
				"manage_goal",
			],
			multiAgentAgentId: spawned.details.agent.id,
			multiAgentParentSessionId: parentHarness.sessionManager.getSessionId(),
			multiAgentRequiresAgentId: true,
			multiAgentRuntimeRole: "child",
		});
		expect(childSessionManager?.getHeader()).toMatchObject({
			parentSession: parentHarness.sessionManager.getSessionFile(),
		});
		expect(childSessionManager?.getSessionId()).not.toBe(parentHarness.sessionManager.getSessionId());
		expect(childSessionManager?.getSessionFile()).not.toBe(parentHarness.sessionManager.getSessionFile());
		expect(parentHarness.sessionManager.buildSessionContext().messages).toEqual(parentMessagesBefore);
	});

	it("inherits only the active earlier branch through the direct production factory", async () => {
		const parentHarness = await createHarness({ persistedSession: true });
		childHarnesses.push(parentHarness);
		parentHarness.sessionManager.appendMessage({
			role: "user",
			content: "Shared branch prefix",
			timestamp: 1,
		});
		const activeBranchLeaf = parentHarness.sessionManager.appendMessage(
			fauxAssistantMessage("Active branch response"),
		);
		parentHarness.sessionManager.branch(activeBranchLeaf);
		parentHarness.sessionManager.appendMessage({
			role: "user",
			content: "Later branch only",
			timestamp: 2,
		});
		parentHarness.sessionManager.appendMessage(fauxAssistantMessage("Later branch response"));
		parentHarness.sessionManager.branch(activeBranchLeaf);
		parentHarness.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall(
					"spawn_agent",
					{ context: "inherit", prompt: "Continue active branch" },
					{ id: "spawn_agent-call" },
				),
				{ stopReason: "toolUse" },
			),
		);
		const parentMessagesBefore = parentHarness.sessionManager.buildSessionContext().messages;
		let childSessionManager: SessionManager | undefined;
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const productionFactory = createProductionChildAgentSessionFactory({
			createSessionManager: SessionManager.create,
			multiAgentStore: store,
			createSession: async (options) => {
				childSessionManager = options.sessionManager;
				return {
					session: {
						bindExtensions: async () => {},
						get messages() {
							return options.sessionManager?.buildSessionContext().messages ?? [];
						},
						prompt: async (prompt) => {
							options.sessionManager?.appendMessage({ role: "user", content: prompt, timestamp: 3 });
							options.sessionManager?.appendMessage(fauxAssistantMessage("active branch child done"));
						},
					},
				};
			},
		});
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			store,
			createChildSession: productionFactory,
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "inherit",
			prompt: "Continue active branch",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(childSessionManager?.buildSessionContext().messages.map(getMessageText)).toEqual([
			"Shared branch prefix",
			"Active branch response",
			"Continue active branch",
			"active branch child done",
		]);
		expect(childSessionManager?.buildSessionContext().messages.map(getMessageText)).not.toContain(
			"Later branch only",
		);
		expect(parentHarness.sessionManager.buildSessionContext().messages).toEqual(parentMessagesBefore);
	});

	it("starts a first-turn inherited child with only its assignment", async () => {
		let parentHarness!: Harness;
		let childSession: Harness["session"] | undefined;
		const store = new MultiAgentStore({ now: () => "2026-07-20T00:00:00.000Z" });
		const createChildSession = createProductionChildAgentSessionFactory({
			createSessionManager: SessionManager.create,
			multiAgentStore: store,
			createSession: async (options) => {
				const result = await createAgentSession({ ...options, authStorage: parentHarness.authStorage });
				childSession = result.session;
				childSessions.push(result.session);
				return { session: result.session };
			},
		});
		parentHarness = await createHarness({
			extensionFactories: [(pi) => multiAgentExtension(pi, { createChildSession, store })],
			multiAgentStore: store,
			persistedSession: true,
		});
		childHarnesses.push(parentHarness);
		const controlDbPath = getControlDbPath(parentHarness.tempDir);
		parentHarness.sessionManager.setMetadataControlDbPath(controlDbPath);
		store.setPersistenceSessionManager(parentHarness.sessionManager);
		await parentHarness.session.bindExtensions({ controlDbPath });
		const response = (context: { messages: Array<{ role: string; content?: unknown }> }) => {
			if (
				context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "Child assignment",
				)
			) {
				return fauxAssistantMessage("Child completed");
			}
			if (context.messages.some((message) => message.role === "toolResult")) {
				return fauxAssistantMessage("Parent completed");
			}
			return fauxAssistantMessage(
				fauxToolCall("spawn_agent", {
					context: "inherit",
					displayName: "Inherited child",
					prompt: "Child assignment",
				}),
				{ stopReason: "toolUse" },
			);
		};
		parentHarness.setResponses([response, response, response]);

		await parentHarness.session.prompt("Unresolved first parent turn");
		if (!childSession) throw new Error("expected child session");
		await childSession.agent.waitForIdle();

		expect(childSession.messages.map(getMessageText)).toEqual(["Child assignment", "Child completed"]);
	});

	it("inherits context through a real tool loop without copying the active spawn call", async () => {
		let parentHarness!: Harness;
		let childSession: Harness["session"] | undefined;
		let siblingCompletedBeforeSpawn = false;
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const sequentialProbe: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "sequential_probe",
				label: "Sequential Probe",
				description: "Complete before the sibling spawn call.",
				parameters: Type.Object({}),
				executionMode: "sequential",
				execute: async () => ({ content: [{ type: "text", text: "probe complete" }], details: {} }),
			});
		};
		const createChildSession = createProductionChildAgentSessionFactory({
			createSessionManager: SessionManager.create,
			multiAgentStore: store,
			createSession: async (options) => {
				siblingCompletedBeforeSpawn = parentHarness.sessionManager
					.buildSessionContext()
					.messages.some((message) => message.role === "toolResult" && message.toolName === "sequential_probe");
				const result = await createAgentSession({ ...options, authStorage: parentHarness.authStorage });
				childSession = result.session;
				childSessions.push(result.session);
				return { session: result.session };
			},
		});
		parentHarness = await createHarness({
			extensionFactories: [sequentialProbe, (pi) => multiAgentExtension(pi, { createChildSession, store })],
			multiAgentStore: store,
			persistedSession: true,
		});
		childHarnesses.push(parentHarness);
		const controlDbPath = getControlDbPath(parentHarness.tempDir);
		parentHarness.sessionManager.setMetadataControlDbPath(controlDbPath);
		store.setPersistenceSessionManager(parentHarness.sessionManager);
		await parentHarness.session.bindExtensions({ controlDbPath });
		parentHarness.sessionManager.appendMessage({
			role: "user",
			content: "Completed parent prefix",
			timestamp: 1,
		});
		parentHarness.sessionManager.appendMessage(fauxAssistantMessage("Completed parent response"));
		parentHarness.session.agent.state.messages = parentHarness.sessionManager.buildSessionContext().messages;
		const response = (context: { messages: Array<{ role: string; content?: unknown }> }) => {
			if (context.messages.some((message) => message.role === "toolResult")) {
				return fauxAssistantMessage("Parent completed");
			}
			if (
				context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "Child assignment",
				)
			) {
				return fauxAssistantMessage("Child completed");
			}
			return fauxAssistantMessage(
				[
					fauxToolCall("sequential_probe", {}),
					fauxToolCall("spawn_agent", {
						context: "inherit",
						displayName: "Inherited child",
						prompt: "Child assignment",
					}),
				],
				{ stopReason: "toolUse" },
			);
		};
		parentHarness.setResponses([response, response, response]);

		await parentHarness.session.prompt("Spawn child");
		if (!childSession) throw new Error("expected child session");
		await childSession.agent.waitForIdle();

		expect(siblingCompletedBeforeSpawn).toBe(true);
		expect(childSession.messages.map(getMessageText)).toEqual([
			"Completed parent prefix",
			"Completed parent response",
			"Spawn child",
			"Child assignment",
			"Child completed",
		]);
		expect(childSession.messages).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					content: expect.arrayContaining([expect.objectContaining({ name: "spawn_agent", type: "toolCall" })]),
				}),
			]),
		);
	});

	it("rejects inherited context when the parent transcript is not persisted", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		const createSession = vi.fn();
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				createSessionManager: SessionManager.create,
				createSession,
			}),
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "inherit",
			prompt: "Continue integrated task",
		});

		expect(spawned.content).toEqual([
			{
				type: "text",
				text: "spawn_agent failed to construct child session: Cannot inherit context from an unpersisted parent session",
			},
		]);
		expect(spawned.details.dispatched).toBe(false);
		expect(createSession).not.toHaveBeenCalled();
	});

	it("denies externally registered manage_goal in production child sessions", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		let childSession: Harness["session"] | undefined;
		let manageGoalCallError: string | undefined;
		const probeExtension: ExtensionFactory = (pi) => {
			pi.on("session_start", async () => {
				try {
					await pi.callTool("manage_goal", { action: "set", objective: "child objective" });
				} catch (error) {
					manageGoalCallError = error instanceof Error ? error.message : String(error);
				}
			});
		};
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				agentDir: parentHarness.tempDir,
				extensionFactories: [externalGoalExtension, probeExtension],
				createSessionManager: SessionManager.create,
				createSession: async (options) => {
					const result = await createAgentSession({ ...options, authStorage: parentHarness.authStorage });
					const session = result.session;
					childSession = session;
					childSessions.push(session);
					return { session };
				},
			}),
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			prompt: "Inspect child tools",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(childSession?.getAllTools().some((tool) => tool.name === "manage_goal")).toBe(false);
		expect(childSession?.getActiveToolNames()).not.toContain("manage_goal");
		expect(manageGoalCallError).toBe("Tool is not active: manage_goal");
	});

	it("denies externally registered manage_goal in production attached sessions", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		const target = SessionManager.create("/repo", parentHarness.tempDir, { id: "attached-session" });
		target.appendMessage({ role: "user", content: "existing", timestamp: 1 });
		target.persistForRecovery();
		let attachedSession: Harness["session"] | undefined;
		const attachedFactory = createProductionAttachedSessionFactory({
			agentDir: parentHarness.tempDir,
			extensionFactories: [externalGoalExtension],
			createSession: async (options) => {
				const result = await createAgentSession({ ...options, authStorage: parentHarness.authStorage });
				const session = result.session;
				attachedSession = session;
				childSessions.push(session);
				return { session };
			},
		});
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const agent = legacyMultiAgentStore(store).spawnAgent({
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

		expect(attachedSession?.getAllTools().some((tool) => tool.name === "manage_goal")).toBe(false);
		expect(attachedSession?.getActiveToolNames()).not.toContain("manage_goal");
	});

	it("keeps attached-session model and effort commands isolated from the viewed sibling", async () => {
		const parentHarness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: true },
			],
		});
		childHarnesses.push(parentHarness);
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const viewedModel = parentHarness.getModel("faux-1");
		const viewedSetModel = vi.fn(async () => {});
		const viewedSetThinkingLevel = vi.fn();
		const viewedAgent = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Viewed sibling",
			permission: { narrowed: true, policy: "on-request" },
		}).agent;
		store.selectActiveAgentTarget(viewedAgent.id);
		runtimeHandles.sessions.set(viewedAgent.id, {
			messages: [],
			prompt: async () => {},
			model: viewedModel,
			thinkingLevel: "medium",
			setModel: viewedSetModel,
			setThinkingLevel: viewedSetThinkingLevel,
		} as never);

		const target = SessionManager.create("/repo", parentHarness.tempDir, { id: "attached-isolation-target" });
		target.persistForRecovery();
		const attachedAgent = legacyMultiAgentStore(store).spawnAgent({
			agentType: "resumed-session",
			cwd: "/repo",
			displayName: "Attached session",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: target.getSessionFile(), sessionId: target.getSessionId() },
		}).agent;
		let attachedSession: Harness["session"] | undefined;
		const attachedFactory = createProductionAttachedSessionFactory({
			agentDir: parentHarness.tempDir,
			extensionFactories: [effortExtension],
			multiAgentStore: store,
			createSession: async (options) => {
				const result = await createAgentSessionWithInternalOptions({
					...options,
					authStorage: parentHarness.authStorage,
				});
				attachedSession = result.session;
				childSessions.push(result.session);
				return { session: result.session };
			},
		});

		await attachedFactory({
			agent: attachedAgent,
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
		if (!attachedSession) throw new Error("expected attached session");

		await attachedSession.prompt("/model faux/faux-2");
		await attachedSession.prompt("/effort high");

		expect(viewedSetModel).not.toHaveBeenCalled();
		expect(viewedSetThinkingLevel).not.toHaveBeenCalled();
		expect(attachedSession.sessionManager.getEntries()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "model_change", modelId: "faux-2" }),
				expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "high" }),
			]),
		);
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
			fauxAssistantMessage(
				fauxToolCall("spawn_agent", { context: "fresh", displayName: "Child", prompt: "child prompt" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("child done"),
			fauxAssistantMessage("parent done"),
		]);

		try {
			process.env[ENV_AGENT_DIR] = agentDir;
			delete process.env[ENV_SELF_RESTART_SESSION];
			delete process.env[ENV_SELF_RESTART_PROMPT];
			delete process.env[ENV_SELF_RESTART_OLD_PID];
			process.chdir(projectDir);
			await main(["-p", "spawn a child", "--model", `${model.provider}/${model.id}`], {
				extensionFactories: [customExtension],
			});
			for (let attempt = 0; attempt < 50 && customExtensionLoads < 2; attempt += 1) {
				await delay(1);
			}

			expect(customExtensionLoads).toBe(2);
		} finally {
			await delay(100);
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
		target.persistForRecovery();
		let sessionOptions: CreateAgentSessionOptions | undefined;
		const attachedFactory = createProductionAttachedSessionFactory({
			createSession: async (options) => {
				sessionOptions = options;
				return { session: { bindExtensions: async () => {}, messages: [], prompt: async () => {} } };
			},
			multiAgentStore: store,
		});
		const agent = legacyMultiAgentStore(store).spawnAgent({
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
			excludeTools: [
				"agent_viewer",
				"attach_session_agent",
				"cancel_agent",
				"list_agents",
				"spawn_agent",
				"steer_agent",
				"wait_agents",
				"manage_goal",
			],
			multiAgentStore: store,
		});
	});

	it("rejects recovery when the persisted child transcript is missing", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const transcriptPath = join(parentHarness.tempDir, "missing-child.jsonl");
		const createSession = vi.fn(async () => ({
			session: { bindExtensions: async () => {}, messages: [], prompt: async () => {} },
		}));
		const attachedFactory = createProductionAttachedSessionFactory({ createSession, multiAgentStore: store });
		const agent = legacyMultiAgentStore(store).spawnAgent({
			agentType: "verifier",
			cwd: "/repo",
			displayName: "Interrupted verifier",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: transcriptPath, sessionId: "expected-child-session" },
		}).agent;

		await expect(
			attachedFactory({
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
				sessionPath: transcriptPath,
			}),
		).rejects.toThrow(`Child agent transcript does not exist: ${transcriptPath}`);
		expect(createSession).not.toHaveBeenCalled();
	});

	it("rejects recovery when the child transcript session identity changed", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		const store = new MultiAgentStore({ now: () => "2026-06-21T00:00:00.000Z" });
		const target = SessionManager.create("/repo", parentHarness.tempDir, { id: "replacement-child-session" });
		target.appendMessage({ role: "user", content: "unrelated context", timestamp: 1 });
		target.appendMessage(fauxAssistantMessage("replacement context"));
		const transcriptPath = target.getSessionFile() ?? "";
		const createSession = vi.fn(async () => ({
			session: { bindExtensions: async () => {}, messages: [], prompt: async () => {} },
		}));
		const attachedFactory = createProductionAttachedSessionFactory({ createSession, multiAgentStore: store });
		const agent = legacyMultiAgentStore(store).spawnAgent({
			agentType: "verifier",
			cwd: "/repo",
			displayName: "Interrupted verifier",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: transcriptPath, sessionId: "original-child-session" },
		}).agent;

		await expect(
			attachedFactory({
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
				sessionPath: transcriptPath,
			}),
		).rejects.toThrow(
			`Child agent transcript session mismatch: expected original-child-session, found replacement-child-session`,
		);
		expect(createSession).not.toHaveBeenCalled();
	});

	it("records production child transcript metadata when the child session is created", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-child-transcript-"));
		const bindExtensions = vi.fn(async () => {});
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
						return {
							session: {
								bindExtensions,
								messages: [fauxAssistantMessage("child transcript ready")],
								prompt: async () => {},
							},
						};
					},
				}),
			});

			const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
				context: "fresh",
				displayName: "Worker",
				prompt: "Work",
			});

			await waitForTerminalAgent(harness, spawned.details.agent.id);
			const agent = store.getAgent(spawned.details.agent.id);
			expect(bindExtensions).toHaveBeenCalledOnce();
			expect(agent?.transcript?.sessionId).toMatch(/^[0-9a-f-]+$/);
			expect(agent?.transcript?.path).toContain(tmp);
			expect(agent?.transcript?.path).toContain(agent?.transcript?.sessionId);
			expect(existsSync(agent?.transcript?.path ?? "")).toBe(true);
		} finally {
			rmSync(tmp, { force: true, recursive: true });
		}
	});

	it("does not seed a session-local goal from the spawn prompt", async () => {
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
							bindExtensions: async () => {},
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
			context: "fresh",
			displayName: "Worker",
			prompt: "  Map the child scope  ",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(childGoalBeforePrompt).toBeUndefined();
		expect(JSON.parse(parentHarness.sessionManager.getSessionGoalJson() ?? "{}")).toMatchObject({
			objective: "parent objective",
		});
	});

	it("does not seed a session-local goal for production /bg child jobs", async () => {
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
							bindExtensions: async () => {},
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

		expect(childGoalBeforePrompt).toBeUndefined();
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

	it("preserves the original prompt and journals transcript-backed child lifecycle", async () => {
		let dispatchedPrompt: string | undefined;
		const createChildSession = createTranscriptBackedFauxSessionFactory(async ({ prompt }) => {
			dispatchedPrompt = prompt;
			return { lifecycle: "completed" };
		});
		const sessionManager = createControlDbSession();
		const harness = createMultiAgentHarness({ createChildSession, ctx: { sessionManager } });
		await harness.emit("session_start");

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			prompt: "  Preserve spacing  ",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(dispatchedPrompt).toBe("  Preserve spacing  ");
		const journalRecords = sessionManager
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" &&
					(entry.customType === "agent_start" || entry.customType === "agent_complete") &&
					(entry.data as { agentId?: string } | undefined)?.agentId === spawned.details.agent.id,
			);
		expect(journalRecords.map((entry) => entry.type === "custom" && entry.customType)).toEqual([
			"agent_start",
			"agent_complete",
		]);
	});

	it("rejects oversized prompts without persisting when no executable runtime exists", async () => {
		const harness = createMultiAgentHarness();
		const prompt = "x".repeat(4001);
		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", { context: "fresh", prompt });
		expect(spawned.details).toMatchObject({ dispatched: false, prompt });
		expect(harness.store.listAgents()).toEqual([]);
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

		const spawned = await harness.call("spawn_agent", { context: "fresh", prompt: "x".repeat(4001) });

		expect(spawned.content).toEqual([{ text: "spawn_agent prompt too long (4001 > 4000 chars)", type: "text" }]);
		expect(harness.store.listAgents()).toEqual([]);
	});

	it("rejects invalid direct production factory prompts before session creation", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		const store = new MultiAgentStore({ now: () => "2026-07-09T00:00:00.000Z" });
		const agent = legacyMultiAgentStore(store).spawnAgent({
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
				context: "fresh",
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

	it("rejects inherited context when the active tool identity is absent from the parent branch", async () => {
		const parentHarness = await createHarness({ persistedSession: true });
		childHarnesses.push(parentHarness);
		parentHarness.sessionManager.appendMessage({ role: "user", content: "Parent context", timestamp: 1 });
		const store = new MultiAgentStore({ now: () => "2026-07-20T00:00:00.000Z" });
		const agent = legacyMultiAgentStore(store).spawnAgent({
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
				activeToolCallId: "missing-tool-call",
				agent,
				context: "inherit",
				ctx: {
					model: parentHarness.getModel(),
					modelRegistry: parentHarness.session.modelRegistry,
					sessionManager: parentHarness.sessionManager,
				} as unknown as ExtensionContext,
				prompt: "Continue work",
			}),
		).rejects.toThrow("active tool call missing-tool-call is not in the parent branch");
		expect(createSession).not.toHaveBeenCalled();
	});

	it("does not inject goal continuation into a completed production child", async () => {
		const parentHarness = await createHarness();
		childHarnesses.push(parentHarness);
		parentHarness.setResponses([fauxAssistantMessage("child done")]);
		let firstSystemPrompt: string | undefined;
		let childSession: Harness["session"] | undefined;
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
				agentDir: parentHarness.tempDir,
				extensionFactories: [firstPartyGoalExtension, captureFirstTurnSystemPrompt],
				createSessionManager: SessionManager.create,
				createSession: async (options) => {
					const result = await createAgentSession({ ...options, authStorage: parentHarness.authStorage });
					childSession = result.session;
					childSessions.push(result.session);
					return { session: result.session };
				},
			}),
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			prompt: "Anchor first child turn",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(firstSystemPrompt).not.toContain("Long-running objective: Anchor first child turn");
		expect(childSession?.sessionManager.getSessionGoalJson()).toBeUndefined();
		expect(
			childSession?.messages.filter((message) => message.role === "user").map((message) => getMessageText(message)),
		).toEqual(["Anchor first child turn"]);
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

		const spawned = await harness.call("spawn_agent", { context: "fresh", prompt: "  " });

		expect(spawned.content).toEqual([{ text: "spawn_agent requires a non-empty prompt", type: "text" }]);
		expect(harness.store.listAgents()).toEqual([]);
	});

	it("does not load goal tools into production child sessions", async () => {
		const parentHarness = await createHarness({ extensionFactories: [goalExtension] });
		childHarnesses.push(parentHarness);
		parentHarness.sessionManager.setSessionGoalJson(
			JSON.stringify({ objective: "parent objective", branch: "test", createdAt: "2026-01-01T00:00:00.000Z" }),
		);
		parentHarness.setResponses([fauxAssistantMessage("child done")]);
		let childSession: Harness["session"] | undefined;
		const harness = createMultiAgentHarness({
			ctx: {
				model: parentHarness.getModel(),
				modelRegistry: parentHarness.session.modelRegistry,
				sessionManager: parentHarness.sessionManager,
			},
			createChildSession: createProductionChildAgentSessionFactory({
				agentDir: parentHarness.tempDir,
				extensionFactories: [firstPartyGoalExtension],
				createSessionManager: SessionManager.create,
				createSession: async (options) => {
					const result = await createAgentSession({
						...options,
						authStorage: parentHarness.authStorage,
					});
					childSession = result.session;
					childSessions.push(result.session);
					return { session: result.session };
				},
			}),
		});

		const spawned = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
			displayName: "Worker",
			prompt: "Set your own goal",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(childSession?.getAllTools().some((tool) => tool.name === "manage_goal")).toBe(false);
		expect(childSession?.sessionManager.getSessionGoalJson()).toBeUndefined();
		expect(parentHarness.session.getAllTools().some((tool) => tool.name === "manage_goal")).toBe(true);
		expect(parentHarness.sessionManager.getSessionGoalJson()).toContain("parent objective");
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
			context: "fresh",
			agentType: "explore",
			prompt: "Map the codebase",
		});
		await waitForTerminalAgent(harness, exploreAgent.details.agent.id);

		expect(sessionOptions?.model).toMatchObject({ provider: "faux", id: "explore-model" });
		expect(sessionOptions?.thinkingLevel).toBe("low");

		const implementAgent = await harness.call<SpawnAgentDetails>("spawn_agent", {
			context: "fresh",
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
			context: "fresh",
			displayName: "Worker",
			prompt: "Check default session dir",
		});
		await waitForTerminalAgent(harness, spawned.details.agent.id);

		expect(sessionOptions?.sessionManager?.getSessionDir()).toBe(parentSessionDir);
	});
});
