import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentSnapshot, MultiAgentStore } from "../src/core/multi-agent-store.ts";
import {
	enqueueRuntimeMailboxMessage,
	getControlDbPath,
	listRuntimeMailboxMessages,
	readRuntimeMailboxMessage,
	upsertMultiAgentMailboxMessage,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";

let storedMessageCounter = 0;

function enqueueStoredRuntimeMessage(
	controlDbPath: string,
	input: {
		body: string;
		kind: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["kind"];
		recipient: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["recipient"];
		sender: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["sender"];
	},
): number {
	storedMessageCounter += 1;
	const messageId = `runtime_test_message_${storedMessageCounter}`;
	const sessionPath = "/sessions/runtime-test-sender.jsonl";
	upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
		body: input.body,
		fromAgentId: input.sender.agentId ?? "main",
		id: messageId,
		kind: input.kind,
		status: "pending",
		toAgentId: input.recipient.agentId ?? "main",
	});
	return enqueueRuntimeMailboxMessage(controlDbPath, {
		kind: input.kind,
		recipient: input.recipient,
		sender: input.sender,
		storeRef: { messageId, sessionPath },
	});
}

import multiAgentExtension, {
	type AgentDesktopNotification,
	type ChildAgentDispatcher,
} from "../src/extensions/multi-agent.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	RegisteredCommand,
	ToolDefinition,
} from "../src/index.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";

type RegisteredTool = Omit<ToolDefinition, "execute"> & {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Record<string, unknown>>>;
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeMailboxPrompt(body: string): string {
	return [
		"Runtime mailbox message received.",
		"",
		"From:",
		"- session: child-session",
		"- agent: agent_1",
		"",
		"Message:",
		body,
		"",
		"To reply, use send_agent_message with:",
		"- toSessionId: child-session",
		'- toAgentId: "main"',
	].join("\n");
}

function collectMultiAgentTools(
	store: MultiAgentStore,
	options: {
		desktopNotifier?: (notification: AgentDesktopNotification) => undefined | { close(): void };
		dispatcher?: ChildAgentDispatcher;
	} = {},
): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerCommand(_name: string, _command: Omit<RegisteredCommand, "name" | "sourceInfo">) {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as ExtensionAPI;
	multiAgentExtension(pi, { desktopNotifier: options.desktopNotifier, dispatcher: options.dispatcher, store });
	return tools;
}

function createRuntimeMailboxContext(input: {
	controlDbPath: string;
	multiAgentAgentId?: string;
	sessionManager: SessionManager;
}): ExtensionContext {
	return {
		controlDbPath: input.controlDbPath,
		cwd: "/repo",
		hasUI: false,
		isIdle: () => true,
		mode: "print",
		multiAgentAgentId: input.multiAgentAgentId,
		sessionManager: input.sessionManager,
	} as unknown as ExtensionContext;
}

describe("runtime SQLite mailbox delivery", () => {
	const harnesses: Harness[] = [];
	let tempDir: string | undefined;

	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		if (tempDir) {
			rmSync(tempDir, { force: true, recursive: true });
			tempDir = undefined;
		}
	});

	it("mirrors child supervisor contact into the runtime mailbox for the parent main session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		writeSessionMetadata(controlDbPath, {
			allMessagesText: "parent",
			createdAt: "2026-07-01T00:00:00.000Z",
			cwd: "/repo",
			firstMessage: "parent",
			id: parentSession.getSessionId(),
			messageCount: 1,
			modifiedAt: "2026-07-01T00:00:00.000Z",
			parentSessionPath: undefined,
			sessionPath: parentSession.getSessionFile() ?? "parent-session",
		});
		const childSession = SessionManager.create(tempDir, join(tempDir, "sessions"), {
			id: "child-session",
			isSubagent: true,
			parentSession: parentSession.getSessionFile(),
			subagentName: "Worker",
		});
		childSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(childSession);
		const child = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { sessionId: childSession.getSessionId() },
		});
		const tools = collectMultiAgentTools(store);
		const contactSupervisor = tools.get("contact_supervisor");
		if (!contactSupervisor) {
			throw new Error("expected contact_supervisor tool");
		}

		await contactSupervisor.execute(
			"contact",
			{ agentId: child.agent.id, expectedRevision: child.agent.revision, message: "Need scope" },
			undefined,
			undefined,
			createRuntimeMailboxContext({
				controlDbPath,
				multiAgentAgentId: child.agent.id,
				sessionManager: childSession,
			}),
		);

		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Need scope",
				recipient: { agentId: null, sessionId: "parent-session" },
				sender: { agentId: child.agent.id, sessionId: "child-session" },
				status: "pending",
			},
		]);
		// The store row is the honest record: it stays pending until the transport
		// actually delivers it in the recipient's process.
		expect(store.listMailboxMessages()).toMatchObject([{ status: "pending" }]);
	});

	it("sends direct messages to an explicit runtime session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const senderSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "sender-session" });
		senderSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(senderSession);
		const parent = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Parent",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
		});
		const child = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Child",
			parentId: parent.agent.id,
			permission: { narrowed: true, policy: "on-request" },
		});
		const parentTranscript = store.updateAgentTranscript(parent.agent.id, { sessionId: "sender-session" });
		expect(parentTranscript.ok).toBe(true);
		const transcript = store.updateAgentTranscript(child.agent.id, { sessionId: "target-session" });
		expect(transcript.ok).toBe(true);
		const tools = collectMultiAgentTools(store);
		const sendAgentMessage = tools.get("send_agent_message");
		if (!sendAgentMessage) {
			throw new Error("expected send_agent_message tool");
		}

		await sendAgentMessage.execute(
			"send",
			{
				message: "Hello other session",
				toAgentId: child.agent.id,
				toSessionId: "target-session",
			},
			undefined,
			undefined,
			createRuntimeMailboxContext({
				controlDbPath,
				multiAgentAgentId: parent.agent.id,
				sessionManager: senderSession,
			}),
		);

		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Hello other session",
				recipient: { agentId: child.agent.id, sessionId: "target-session" },
				sender: { agentId: parent.agent.id, sessionId: "sender-session" },
				status: "pending",
			},
		]);
		// The store row is the honest record: it stays pending until the recipient's
		// process actually delivers the transport row.
		expect(store.listMailboxMessages()).toMatchObject([{ status: "pending" }]);
	});

	it("sends direct messages to an explicit main runtime session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const senderSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "sender-session" });
		senderSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(senderSession);
		const tools = collectMultiAgentTools(store);
		const sendAgentMessage = tools.get("send_agent_message");
		if (!sendAgentMessage) {
			throw new Error("expected send_agent_message tool");
		}

		await sendAgentMessage.execute(
			"send-main",
			{
				message: "Hello main session",
				toAgentId: "main",
				toSessionId: "target-session",
			},
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: senderSession }),
		);

		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Hello main session",
				recipient: { agentId: null, sessionId: "target-session" },
				sender: { agentId: null, sessionId: "sender-session" },
				status: "pending",
			},
		]);
	});

	it("rejects explicit runtime sessions that do not match the target agent transcript", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const senderSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "sender-session" });
		senderSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(senderSession);
		const parent = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Parent",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
		});
		const child = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Child",
			parentId: parent.agent.id,
			permission: { narrowed: true, policy: "on-request" },
		});
		const parentTranscript = store.updateAgentTranscript(parent.agent.id, { sessionId: "sender-session" });
		expect(parentTranscript.ok).toBe(true);
		const tools = collectMultiAgentTools(store);
		const sendAgentMessage = tools.get("send_agent_message");
		if (!sendAgentMessage) {
			throw new Error("expected send_agent_message tool");
		}

		const sent = await sendAgentMessage.execute(
			"send-mismatch",
			{
				message: "Hello wrong session",
				toAgentId: child.agent.id,
				toSessionId: "target-session",
			},
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: senderSession }),
		);

		expect(sent.details.message).toMatchObject({ status: "failed", toAgentId: child.agent.id });
		expect(store.listMailboxMessages()).toEqual([]);
		expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
	});

	it("mirrors steering into the runtime mailbox for a child session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		const childSession = SessionManager.create(tempDir, join(tempDir, "sessions"), {
			id: "child-session",
			isSubagent: true,
			parentSession: parentSession.getSessionFile(),
			subagentName: "Worker",
		});
		childSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(childSession);
		const child = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { sessionId: childSession.getSessionId() },
		});
		const starting = store.transitionAgent(child.agent.id, child.agent.revision, "starting");
		expect(starting.ok).toBe(true);
		if (!starting.ok) throw new Error("expected starting transition");
		const running = store.transitionAgent(starting.agent.id, starting.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) throw new Error("expected running transition");
		const tools = collectMultiAgentTools(store);
		const steerAgent = tools.get("steer_agent");
		if (!steerAgent) {
			throw new Error("expected steer_agent tool");
		}

		await steerAgent.execute(
			"steer",
			{ agentId: child.agent.id, expectedRevision: running.agent.revision, message: "Check permissions" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);

		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Check permissions",
				recipient: { agentId: child.agent.id, sessionId: "child-session" },
				sender: { agentId: "supervisor", sessionId: "parent-session" },
				status: "pending",
			},
		]);
	});

	it("mirrors dispatched child waiting-for-input notification into the runtime mailbox for the parent main session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		const waitingAgents: AgentSnapshot[] = [];
		const dispatcher: ChildAgentDispatcher = async ({ agent }) => {
			waitingAgents.push(agent);
			return { lifecycle: "waiting_for_input" };
		};
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const tools = collectMultiAgentTools(store, { dispatcher });
		const spawnAgent = tools.get("spawn_agent");
		if (!spawnAgent) {
			throw new Error("expected spawn_agent tool");
		}

		await spawnAgent.execute(
			"spawn",
			{ displayName: "Worker", prompt: "ask user" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		for (let attempt = 0; attempt < 20 && waitingAgents.length === 0; attempt += 1) {
			await delay(1);
		}

		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Worker is waiting for input.",
				recipient: { agentId: null, sessionId: "parent-session" },
				sender: { agentId: "agent_1", sessionId: "parent-session" },
				status: "pending",
			},
		]);
	});

	it("mirrors child waiting-for-input notification before the dispatch resolves", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		let transitionedToWaiting = false;
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const dispatcher: ChildAgentDispatcher = ({ agent }) => {
			const waiting = store.transitionAgent(agent.id, agent.revision, "waiting_for_input");
			expect(waiting.ok).toBe(true);
			transitionedToWaiting = true;
			return new Promise(() => undefined);
		};
		const tools = collectMultiAgentTools(store, { dispatcher });
		const spawnAgent = tools.get("spawn_agent");
		if (!spawnAgent) {
			throw new Error("expected spawn_agent tool");
		}

		await spawnAgent.execute(
			"spawn",
			{ displayName: "Worker", prompt: "ask user" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		for (let attempt = 0; attempt < 20 && !transitionedToWaiting; attempt += 1) {
			await delay(1);
		}

		expect(transitionedToWaiting).toBe(true);
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Worker is waiting for input.",
				recipient: { agentId: null, sessionId: "parent-session" },
				sender: { agentId: "agent_1", sessionId: "parent-session" },
				status: "pending",
			},
		]);
	});

	it("sends a non-expiring desktop notification when a dispatched child waits for input", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		const desktopNotifications: AgentDesktopNotification[] = [];
		const dispatcher: ChildAgentDispatcher = async () => ({ lifecycle: "waiting_for_input" });
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		const tools = collectMultiAgentTools(store, {
			desktopNotifier: (notification) => {
				desktopNotifications.push(notification);
				return undefined;
			},
			dispatcher,
		});
		const spawnAgent = tools.get("spawn_agent");
		if (!spawnAgent) {
			throw new Error("expected spawn_agent tool");
		}

		await spawnAgent.execute(
			"spawn",
			{ displayName: "Worker", prompt: "ask user" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		for (let attempt = 0; attempt < 20 && desktopNotifications.length === 0; attempt += 1) {
			await delay(1);
		}

		expect(desktopNotifications).toEqual([
			{
				body: "Worker is waiting for input.",
				title: "Pi agent needs input",
			},
		]);
	});

	it("keeps a waiting-for-input desktop notification until the dispatch finishes", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		const close = vi.fn();
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		let resolveDispatch: ((value: { lifecycle: "completed" }) => void) | undefined;
		const dispatcher: ChildAgentDispatcher = ({ agent }) =>
			new Promise<{ lifecycle: "completed" }>((resolve) => {
				resolveDispatch = resolve;
				const waiting = store.transitionAgent(agent.id, agent.revision, "waiting_for_input");
				expect(waiting.ok).toBe(true);
			});
		const tools = collectMultiAgentTools(store, {
			desktopNotifier: () => ({ close }),
			dispatcher,
		});
		const spawnAgent = tools.get("spawn_agent");
		const waitAgent = tools.get("wait_agent");
		if (!spawnAgent || !waitAgent) {
			throw new Error("expected spawn_agent and wait_agent tools");
		}

		await spawnAgent.execute(
			"spawn",
			{ displayName: "Worker", prompt: "ask user" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		await delay(5);
		expect(close).not.toHaveBeenCalled();

		if (!resolveDispatch) {
			throw new Error("expected pending waiting agent dispatch");
		}
		resolveDispatch({ lifecycle: "completed" });
		await waitAgent.execute(
			"wait",
			{ agentId: "agent_1" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);

		expect(close).toHaveBeenCalledOnce();
	});

	it("closes a waiting-for-input desktop notification when steering resumes a settled waiting agent", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		const close = vi.fn();
		const dispatcher: ChildAgentDispatcher = async () => ({ lifecycle: "waiting_for_input" });
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		const tools = collectMultiAgentTools(store, {
			desktopNotifier: () => ({ close }),
			dispatcher,
		});
		const spawnAgent = tools.get("spawn_agent");
		const waitAgent = tools.get("wait_agent");
		if (!spawnAgent || !waitAgent) {
			throw new Error("expected spawn_agent and wait_agent tools");
		}

		await spawnAgent.execute(
			"spawn",
			{ displayName: "Worker", prompt: "ask user" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		await waitAgent.execute(
			"wait",
			{ agentId: "agent_1" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		expect(close).not.toHaveBeenCalled();

		const waitingAgent = store.getAgent("agent_1");
		if (!waitingAgent) {
			throw new Error("expected waiting agent");
		}
		const steered = store.sendSteering(waitingAgent.id, waitingAgent.revision, {
			body: "continue",
			fromAgentId: "main",
		});
		expect(steered.ok).toBe(true);

		expect(close).toHaveBeenCalledOnce();
	});

	it("mirrors waiting-for-input notification even when desktop notification fails", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const dispatcher: ChildAgentDispatcher = async () => ({ lifecycle: "waiting_for_input" });
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const tools = collectMultiAgentTools(store, {
			desktopNotifier: () => {
				throw new Error("notification failed");
			},
			dispatcher,
		});
		const spawnAgent = tools.get("spawn_agent");
		if (!spawnAgent) {
			throw new Error("expected spawn_agent tool");
		}

		await spawnAgent.execute(
			"spawn",
			{ displayName: "Worker", prompt: "ask user" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		for (let attempt = 0; attempt < 20 && listRuntimeMailboxMessages(controlDbPath).length === 0; attempt += 1) {
			await delay(1);
		}

		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Worker is waiting for input.",
				recipient: { agentId: null, sessionId: "parent-session" },
				status: "pending",
			},
		]);
		expect(consoleError).toHaveBeenCalledWith(
			"Failed to send agent input-needed desktop notification:",
			expect.any(Error),
		);
		consoleError.mockRestore();
	});

	it("mirrors dispatched child completion into the runtime mailbox for the parent main session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		const completedAgents: AgentSnapshot[] = [];
		const dispatcher: ChildAgentDispatcher = async ({ agent }) => {
			completedAgents.push(agent);
			return { lifecycle: "completed", result: { summary: "tests passed" } };
		};
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const tools = collectMultiAgentTools(store, { dispatcher });
		const spawnAgent = tools.get("spawn_agent");
		if (!spawnAgent) {
			throw new Error("expected spawn_agent tool");
		}

		await spawnAgent.execute(
			"spawn",
			{ displayName: "Worker", prompt: "run tests" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		for (let attempt = 0; attempt < 20 && completedAgents.length === 0; attempt += 1) {
			await delay(1);
		}

		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Worker completed: tests passed",
				recipient: { agentId: null, sessionId: "parent-session" },
				sender: { agentId: "agent_1", sessionId: "parent-session" },
				status: "pending",
			},
		]);
	});

	it("wait_agent consumes the mirrored completion notification from the runtime mailbox", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		const dispatcher: ChildAgentDispatcher = async () => ({
			lifecycle: "completed",
			result: { summary: "tests passed" },
		});
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const tools = collectMultiAgentTools(store, { dispatcher });
		const spawnAgent = tools.get("spawn_agent");
		const waitAgent = tools.get("wait_agent");
		if (!spawnAgent || !waitAgent) {
			throw new Error("expected spawn_agent and wait_agent tools");
		}
		const ctx = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });

		const spawned = await spawnAgent.execute(
			"spawn",
			{ displayName: "Worker", prompt: "run tests" },
			undefined,
			undefined,
			ctx,
		);
		const agentId = (spawned.details as { agent: AgentSnapshot }).agent.id;
		for (let attempt = 0; attempt < 50 && listRuntimeMailboxMessages(controlDbPath).length === 0; attempt += 1) {
			await delay(1);
		}
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([{ status: "pending" }]);

		await waitAgent.execute("wait", { agentId }, undefined, undefined, ctx);

		// wait_agent already reported the terminal state, so the completion notice
		// must not be delivered again as a mailbox prompt.
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([{ status: "delivered" }]);
	});

	it("drains claimed runtime mailbox messages at the end of a turn", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("initial reply"), fauxAssistantMessage("mailbox reply")]);
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Child finished tests",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["hello", runtimeMailboxPrompt("Child finished tests")]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
	});

	it("starts runtime mailbox polling before extension binding", async () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.setMetadataControlDbPath(controlDbPath);
		harness.setResponses([fauxAssistantMessage("mailbox reply")]);
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Constructor poll wake",
			kind: "message",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});

		await vi.advanceTimersByTimeAsync(3_000);
		for (let attempt = 0; attempt < 10 && getUserTexts(harness).length === 0; attempt += 1) {
			await delay(0);
		}
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([runtimeMailboxPrompt("Constructor poll wake")]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
	});

	it("drains runtime mailbox using session metadata control DB fallback", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		harness.sessionManager.setMetadataControlDbPath(controlDbPath);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("initial reply"), fauxAssistantMessage("mailbox reply")]);
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Fallback path notice",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["hello", runtimeMailboxPrompt("Fallback path notice")]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
	});

	it("polls the runtime mailbox while external input is reserved", async () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("mailbox reply")]);
		const releaseReservation = harness.session.reserveExternalUserInput();
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Reserved input wake",
			kind: "message",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});

		try {
			await vi.advanceTimersByTimeAsync(3_000);
			for (let attempt = 0; attempt < 10 && getUserTexts(harness).length === 0; attempt += 1) {
				await delay(0);
			}
			await harness.session.agent.waitForIdle();
		} finally {
			releaseReservation();
		}

		expect(getUserTexts(harness)).toEqual([runtimeMailboxPrompt("Reserved input wake")]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
	});

	it("polls the runtime mailbox while idle and wakes the main session", async () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("mailbox reply")]);
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Need parent review",
			kind: "message",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});

		await vi.advanceTimersByTimeAsync(3_000);
		for (let attempt = 0; attempt < 10 && getUserTexts(harness).length === 0; attempt += 1) {
			await delay(0);
		}
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([runtimeMailboxPrompt("Need parent review")]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
	});
});
