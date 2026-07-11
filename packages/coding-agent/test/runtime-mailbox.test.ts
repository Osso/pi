import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS } from "../src/core/desktop-notification.ts";
import { type AgentMailboxMessage, type AgentSnapshot, MultiAgentStore } from "../src/core/multi-agent-store.ts";
import {
	claimRuntimeMailboxMessages,
	consumeRuntimeMailboxMessageByStoreRef,
	enqueueRuntimeMailboxMessage,
	getControlDbPath,
	initializeSharedChannelCursorAtTail,
	listRuntimeMailboxListeners,
	listRuntimeMailboxMessages,
	markMultiAgentMailboxMessageDelivered,
	postSharedChannelMessage,
	readRuntimeMailboxMessage,
	readSessionHealth,
	readSharedChannelCursor,
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

import { createHostrunMultiAgentRequestHandler } from "../extensions/agents-core/src/runtime.ts";
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
	return ["From:", "- session: child-session", "- agent: agent_1", "", "Message:", body].join("\n");
}

function sharedChannelPrompt(body: string, sessionId = "sender-session"): string {
	return ["From shared channel:", `- session: ${sessionId}`, "- agent: main", "", "Message:", body].join("\n");
}

function collectMultiAgentTools(
	store: MultiAgentStore,
	options: {
		desktopNotifier?: (notification: AgentDesktopNotification) => undefined | { close(): void };
		dispatcher?: ChildAgentDispatcher;
		onSessionMessageSent?: (input: { message: AgentMailboxMessage; toSessionId: string }) => void;
	} = {},
): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerCommand(_name: string, _command: Omit<RegisteredCommand, "name" | "sourceInfo">) {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as ExtensionAPI;
	multiAgentExtension(pi, {
		desktopNotifier: options.desktopNotifier,
		dispatcher: options.dispatcher,
		onSessionMessageSent: options.onSessionMessageSent,
		store,
	});
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

	it("does not drain runtime coordination after the session is disposed", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const drainableSession = harness.session as unknown as {
			_drainRuntimeCoordinationMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		harness.session.dispose();
		rmSync(tempDir, { force: true, recursive: true });
		tempDir = undefined;

		await expect(drainableSession._drainRuntimeCoordinationMessages({ triggerIfIdle: true })).resolves.toBe(false);
	});

	it("keeps the supervisor main listener when an in-process child binds the same control DB", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parent = await createHarness({ persistedSession: true });
		const child = await createHarness({ multiAgentAgentId: "agent_1", persistedSession: true });
		harnesses.push(parent, child);

		await parent.session.bindExtensions({ controlDbPath });
		await child.session.bindExtensions({ controlDbPath });

		const parentSessionId = parent.session.sessionId;
		const childSessionId = child.session.sessionId;
		const listeners = listRuntimeMailboxListeners(controlDbPath);
		expect(listeners.filter((listener) => listener.agentId === null)).toEqual([
			expect.objectContaining({ sessionId: parentSessionId, pid: process.pid }),
		]);
		expect(listeners).toContainEqual(
			expect.objectContaining({ agentId: "agent_1", sessionId: childSessionId, pid: process.pid }),
		);
		expect(readSessionHealth(controlDbPath, parentSessionId)).toMatchObject({
			pid: process.pid,
			checkStatus: "ok",
		});
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

	it("fails direct messages to explicit child runtime sessions when transport mirroring is unavailable", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const senderSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "sender-session" });
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
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
		expect(store.updateAgentTranscript(child.agent.id, { sessionId: "target-session" }).ok).toBe(true);
		const tools = collectMultiAgentTools(store);
		const sendAgentMessage = tools.get("send_agent_message");
		if (!sendAgentMessage) {
			throw new Error("expected send_agent_message tool");
		}

		const sent = await sendAgentMessage.execute(
			"send-child-unavailable",
			{
				message: "Hello unreachable child session",
				toAgentId: child.agent.id,
				toSessionId: "target-session",
			},
			undefined,
			undefined,
			createRuntimeMailboxContext({
				controlDbPath: "",
				multiAgentAgentId: parent.agent.id,
				sessionManager: senderSession,
			}),
		);

		expect(sent.content[0]).toMatchObject({
			text: "Could not send runtime session message: runtime mailbox transport is unavailable.",
		});
		expect(sent.details.message).toMatchObject({ status: "failed" });
		expect(store.listMailboxMessages()).toMatchObject([{ status: "failed" }]);
		expect(listRuntimeMailboxMessages(getControlDbPath(tempDir))).toEqual([]);
	});

	it("fails explicit main runtime session messages without leaving a pending store row", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const senderSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "sender-session" });
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		const tools = collectMultiAgentTools(store);
		const sendAgentMessage = tools.get("send_agent_message");
		if (!sendAgentMessage) {
			throw new Error("expected send_agent_message tool");
		}

		const sent = await sendAgentMessage.execute(
			"send-main-unavailable",
			{
				message: "Hello unreachable main session",
				toAgentId: "main",
				toSessionId: "target-session",
			},
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath: "", sessionManager: senderSession }),
		);

		expect(sent.content[0]).toMatchObject({
			text: "Could not send runtime session message: runtime mailbox transport is unavailable.",
		});
		expect(sent.details.message).toMatchObject({ status: "failed" });
		expect(store.listMailboxMessages()).toMatchObject([{ status: "failed" }]);
		expect(listRuntimeMailboxMessages(getControlDbPath(tempDir))).toEqual([]);
	});

	it("sends direct messages to an explicit main runtime session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const senderSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "sender-session" });
		senderSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(senderSession);
		const onSessionMessageSent = vi.fn();
		const tools = collectMultiAgentTools(store, { onSessionMessageSent });
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

		expect(onSessionMessageSent).toHaveBeenCalledWith({
			message: expect.objectContaining({ body: "Hello main session" }),
			toSessionId: "target-session",
		});
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

	it("mirrors child waiting-for-input notification after the dispatch listener is gone", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		const harness = await createHarness({
			extensionFactories: [(pi) => multiAgentExtension(pi, { store })],
			multiAgentStore: store,
			persistedSession: true,
		});
		harnesses.push(harness);
		const controlDbPath = getControlDbPath(tempDir);
		harness.sessionManager.setMetadataControlDbPath(controlDbPath);
		store.setPersistenceSessionManager(harness.sessionManager);
		await harness.session.bindExtensions({ controlDbPath });
		const child = store.spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
		});
		const starting = store.transitionAgent(child.agent.id, child.agent.revision, "starting");
		expect(starting.ok).toBe(true);
		if (!starting.ok) throw new Error("expected starting transition");
		const running = store.transitionAgent(child.agent.id, starting.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) throw new Error("expected running transition");

		const waiting = store.transitionAgent(child.agent.id, running.agent.revision, "waiting_for_input");

		expect(waiting.ok).toBe(true);
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Worker is waiting for input.",
				recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
				sender: { agentId: child.agent.id, sessionId: harness.sessionManager.getSessionId() },
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

	it("sends a persistent desktop notification when a dispatched child waits for input", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const desktopNotifications: AgentDesktopNotification[] = [];
		const dispatcher: ChildAgentDispatcher = async () => ({ lifecycle: "waiting_for_input" });
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
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
				expireTimeMs: PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS,
				title: "Pi agent needs input",
			},
		]);
	});

	it("keeps a waiting-for-input desktop notification until the dispatch finishes", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const close = vi.fn();
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
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
		const waitAgents = tools.get("wait_agents");
		if (!spawnAgent || !waitAgents) {
			throw new Error("expected spawn_agent and wait_agents tools");
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
		await waitAgents.execute(
			"wait",
			{},
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
		parentSession.setMetadataControlDbPath(controlDbPath);
		const close = vi.fn();
		const dispatcher: ChildAgentDispatcher = async () => ({ lifecycle: "waiting_for_input" });
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const tools = collectMultiAgentTools(store, {
			desktopNotifier: () => ({ close }),
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
		for (
			let attempt = 0;
			attempt < 50 && store.getAgent("agent_1")?.lifecycle !== "waiting_for_input";
			attempt += 1
		) {
			await delay(1);
		}
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

	it("Hostrun agents.wait consumes the mirrored completion notification", async () => {
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
		const handler = createHostrunMultiAgentRequestHandler({ dispatcher, store });
		const ctx = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });

		await handler({ method: "agents.spawn", params: { displayName: "Worker", prompt: "run tests" } }, ctx, undefined);
		for (let attempt = 0; attempt < 50 && listRuntimeMailboxMessages(controlDbPath).length === 0; attempt += 1) {
			await delay(1);
		}
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([{ status: "pending" }]);

		const waited = await handler({ method: "agents.wait", params: {} }, ctx, undefined);

		expect(waited).toBeNull();
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([{ status: "delivered" }]);
	});

	it("wait_agents consumes the mirrored completion notification", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		const dispatcher: ChildAgentDispatcher = async () => ({
			lifecycle: "completed",
			result: { durationMs: 1234, summary: "tests passed" },
		});
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const tools = collectMultiAgentTools(store, { dispatcher });
		const spawnAgent = tools.get("spawn_agent");
		const waitAgents = tools.get("wait_agents");
		if (!spawnAgent || !waitAgents) {
			throw new Error("expected spawn_agent and wait_agents tools");
		}
		const ctx = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });

		await spawnAgent.execute("spawn", { displayName: "Worker", prompt: "run tests" }, undefined, undefined, ctx);
		for (let attempt = 0; attempt < 50 && listRuntimeMailboxMessages(controlDbPath).length === 0; attempt += 1) {
			await delay(1);
		}
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([{ status: "pending" }]);

		const waited = await waitAgents.execute("wait", {}, undefined, undefined, ctx);

		expect(waited.content[0]).toMatchObject({ text: "Worker completed: tests passed. Duration: 1234ms" });
		expect(waited.details).toMatchObject({ agent: { result: { durationMs: 1234 } } });
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{ body: "Worker completed: tests passed. Duration: 1234ms", status: "delivered" },
		]);
	});

	it("wait-style store consumption delivers already claimed runtime completion notifications", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const sessionPath = "/sessions/runtime-test-sender.jsonl";
		const messageId = "completion-message";
		upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
			body: "Worker completed: tests passed",
			fromAgentId: "agent_1",
			id: messageId,
			kind: "system",
			status: "pending",
			toAgentId: "main",
		});
		const runtimeMessageId = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "system",
			recipient: { agentId: null, sessionId: "parent-session" },
			sender: { agentId: "agent_1", sessionId: "parent-session" },
			storeRef: { messageId, sessionPath },
		});

		const claimed = claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });
		expect(claimed).toHaveLength(1);

		consumeRuntimeMailboxMessageByStoreRef(controlDbPath, { messageId, sessionPath });

		expect(readRuntimeMailboxMessage(controlDbPath, runtimeMessageId)).toMatchObject({ status: "delivered" });
	});

	it("batches unread shared channel chatter into one idle agent turn and advances the cursor", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("channel reply")]);
		initializeSharedChannelCursorAtTail(controlDbPath, {
			agentId: null,
			sessionId: harness.sessionManager.getSessionId(),
		});
		postSharedChannelMessage(controlDbPath, {
			body: "First shared status?",
			sender: { agentId: null, sessionId: "sender-session-a" },
		});
		postSharedChannelMessage(controlDbPath, {
			body: "self note",
			sender: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
		});
		postSharedChannelMessage(controlDbPath, {
			body: "old subagent pong",
			sender: { agentId: "agent_4", sessionId: "sender-session" },
		});
		const messageId = postSharedChannelMessage(controlDbPath, {
			body: "Second shared status?",
			sender: { agentId: null, sessionId: "sender-session-b" },
		});
		const drainableSession = harness.session as unknown as {
			_drainSharedChannelMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		const queued = await drainableSession._drainSharedChannelMessages({ triggerIfIdle: true });
		await harness.session.agent.waitForIdle();

		expect(queued).toBe(false);
		expect(getUserTexts(harness)).toEqual([
			[
				sharedChannelPrompt("First shared status?", "sender-session-a"),
				sharedChannelPrompt("Second shared status?", "sender-session-b"),
			].join("\n\n"),
		]);
		expect(
			readSharedChannelCursor(controlDbPath, { agentId: null, sessionId: harness.sessionManager.getSessionId() }),
		).toBe(messageId);
	});

	it("batches every unread shared channel message across database pages into one idle agent turn", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("channel reply")]);
		const recipient = { agentId: null, sessionId: harness.sessionManager.getSessionId() };
		initializeSharedChannelCursorAtTail(controlDbPath, recipient);
		const deliverableBodies = Array.from({ length: 21 }, (_, index) => `Shared status ${index + 1}`);
		let lastMessageId = 0;
		for (const [index, body] of deliverableBodies.entries()) {
			if (index === 7) {
				postSharedChannelMessage(controlDbPath, {
					body: "self note",
					sender: { agentId: null, sessionId: recipient.sessionId },
				});
			}
			if (index === 14) {
				postSharedChannelMessage(controlDbPath, {
					body: "old subagent pong",
					sender: { agentId: "agent_4", sessionId: "sender-session" },
				});
			}
			lastMessageId = postSharedChannelMessage(controlDbPath, {
				body,
				sender: { agentId: null, sessionId: `sender-session-${index + 1}` },
			});
		}
		const drainableSession = harness.session as unknown as {
			_drainSharedChannelMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		const queued = await drainableSession._drainSharedChannelMessages({ triggerIfIdle: true });
		await harness.session.agent.waitForIdle();

		expect(queued).toBe(false);
		expect(getUserTexts(harness)).toEqual([
			deliverableBodies.map((body, index) => sharedChannelPrompt(body, `sender-session-${index + 1}`)).join("\n\n"),
		]);
		expect(readSharedChannelCursor(controlDbPath, recipient)).toBe(lastMessageId);
	});

	it("retains every unread shared channel message after a failed batch delivery", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const recipient = { agentId: null, sessionId: harness.sessionManager.getSessionId() };
		const initialCursor = initializeSharedChannelCursorAtTail(controlDbPath, recipient);
		const deliverableBodies = Array.from({ length: 21 }, (_, index) => `Retry shared status ${index + 1}`);
		for (const [index, body] of deliverableBodies.entries()) {
			postSharedChannelMessage(controlDbPath, {
				body,
				sender: { agentId: null, sessionId: `sender-session-${index + 1}` },
			});
		}
		const prompt = vi.spyOn(harness.session, "prompt").mockRejectedValue(new Error("channel delivery failed"));
		const drainableSession = harness.session as unknown as {
			_drainSharedChannelMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		await expect(drainableSession._drainSharedChannelMessages({ triggerIfIdle: true })).rejects.toThrow(
			"channel delivery failed",
		);
		expect(readSharedChannelCursor(controlDbPath, recipient)).toBe(initialCursor);

		prompt.mockRestore();
		harness.setResponses([fauxAssistantMessage("channel reply")]);
		await drainableSession._drainSharedChannelMessages({ triggerIfIdle: true });
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([
			deliverableBodies.map((body, index) => sharedChannelPrompt(body, `sender-session-${index + 1}`)).join("\n\n"),
		]);
		expect(readSharedChannelCursor(controlDbPath, recipient)).toBe(initialCursor + deliverableBodies.length);
	});

	it("retains every unread shared channel message after a busy delivery attempt", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const recipient = { agentId: null, sessionId: harness.sessionManager.getSessionId() };
		const initialCursor = initializeSharedChannelCursorAtTail(controlDbPath, recipient);
		const deliverableBodies = Array.from({ length: 21 }, (_, index) => `Busy shared status ${index + 1}`);
		for (const [index, body] of deliverableBodies.entries()) {
			postSharedChannelMessage(controlDbPath, {
				body,
				sender: { agentId: null, sessionId: `sender-session-${index + 1}` },
			});
		}
		const prompt = vi
			.spyOn(harness.session, "prompt")
			.mockRejectedValue(
				new Error(
					"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
				),
			);
		const drainableSession = harness.session as unknown as {
			_drainSharedChannelMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		expect(await drainableSession._drainSharedChannelMessages({ triggerIfIdle: true })).toBe(false);
		expect(readSharedChannelCursor(controlDbPath, recipient)).toBe(initialCursor);

		prompt.mockRestore();
		harness.setResponses([fauxAssistantMessage("channel reply")]);
		await drainableSession._drainSharedChannelMessages({ triggerIfIdle: true });
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([
			deliverableBodies.map((body, index) => sharedChannelPrompt(body, `sender-session-${index + 1}`)).join("\n\n"),
		]);
		expect(readSharedChannelCursor(controlDbPath, recipient)).toBe(initialCursor + deliverableBodies.length);
	});

	it("does not deliver shared channel messages posted by the same recipient", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		initializeSharedChannelCursorAtTail(controlDbPath, {
			agentId: null,
			sessionId: harness.sessionManager.getSessionId(),
		});
		const messageId = postSharedChannelMessage(controlDbPath, {
			body: "self note",
			sender: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
		});
		const drainableSession = harness.session as unknown as {
			_drainSharedChannelMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		const queued = await drainableSession._drainSharedChannelMessages({ triggerIfIdle: true });

		expect(queued).toBe(false);
		expect(getUserTexts(harness)).toEqual([]);
		expect(
			readSharedChannelCursor(controlDbPath, { agentId: null, sessionId: harness.sessionManager.getSessionId() }),
		).toBe(messageId);
	});

	it("skips shared channel messages posted by subagent senders", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		initializeSharedChannelCursorAtTail(controlDbPath, {
			agentId: null,
			sessionId: harness.sessionManager.getSessionId(),
		});
		const messageId = postSharedChannelMessage(controlDbPath, {
			body: "old subagent pong",
			sender: { agentId: "agent_4", sessionId: "sender-session" },
		});
		const drainableSession = harness.session as unknown as {
			_drainSharedChannelMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		const queued = await drainableSession._drainSharedChannelMessages({ triggerIfIdle: true });

		expect(queued).toBe(false);
		expect(getUserTexts(harness)).toEqual([]);
		expect(
			readSharedChannelCursor(controlDbPath, { agentId: null, sessionId: harness.sessionManager.getSessionId() }),
		).toBe(messageId);
	});

	it("does not drain shared channel messages in subagent sessions by default", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness({ multiAgentAgentId: "agent_1" });
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const initialCursor = initializeSharedChannelCursorAtTail(controlDbPath, {
			agentId: "agent_1",
			sessionId: harness.sessionManager.getSessionId(),
		});
		postSharedChannelMessage(controlDbPath, {
			body: "shared note for main threads only",
			sender: { agentId: null, sessionId: "sender-session" },
		});
		const drainableSession = harness.session as unknown as {
			_drainSharedChannelMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		const queued = await drainableSession._drainSharedChannelMessages({ triggerIfIdle: true });

		expect(queued).toBe(false);
		expect(getUserTexts(harness)).toEqual([]);
		expect(
			readSharedChannelCursor(controlDbPath, {
				agentId: "agent_1",
				sessionId: harness.sessionManager.getSessionId(),
			}),
		).toBe(initialCursor);
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

	it("keeps runtime mailbox messages pending when idle delivery races with an active prompt", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Child finished during a provider timeout",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const drainableSession = harness.session as unknown as {
			_drainRuntimeMailboxMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
			prompt(text: string, options?: unknown): Promise<void>;
		};
		drainableSession.prompt = async () => {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		};

		const queued = await drainableSession._drainRuntimeMailboxMessages({ triggerIfIdle: true });

		expect(queued).toBe(false);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "pending" });
	});

	it("silently consumes transport rows whose store message was already delivered", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("initial reply")]);
		const sessionPath = "/sessions/runtime-test-sender.jsonl";
		const messageId = "runtime_test_delivered_message";
		upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, messageId, {
			body: "Already delivered stale message",
			fromAgentId: "agent_1",
			id: messageId,
			kind: "system",
			status: "pending",
			toAgentId: "main",
		});
		markMultiAgentMailboxMessageDelivered(controlDbPath, sessionPath, messageId);
		const runtimeMessageId = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "system",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
			storeRef: { messageId, sessionPath },
		});

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["hello"]);
		expect(readRuntimeMailboxMessage(controlDbPath, runtimeMessageId)).toMatchObject({ status: "delivered" });
	});

	it("marks runtime mailbox steer delivery and completion in the parent store", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		const harness = await createHarness({
			multiAgentAgentId: "agent_1",
			multiAgentStore: store,
			persistedSession: true,
		});
		harnesses.push(harness);
		harness.sessionManager.setMetadataControlDbPath(controlDbPath);
		store.setPersistenceSessionManager(harness.sessionManager);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("initial reply"), fauxAssistantMessage("steer done")]);
		const spawned = store.spawnAgent({
			agentType: "verifier",
			cwd: harness.tempDir,
			displayName: "Verifier",
			lifecycle: "starting",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { sessionId: harness.sessionManager.getSessionId() },
		});
		const running = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) throw new Error("expected running transition");
		const steered = store.sendSteering(spawned.agent.id, running.agent.revision, {
			body: "Continue verification",
			fromAgentId: "supervisor",
		});
		expect(steered.ok).toBe(true);
		if (!steered.ok) throw new Error("expected steering to succeed");
		const persistence = store.getPersistenceTarget();
		if (!persistence) throw new Error("expected store persistence target");
		const runtimeMessageId = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "steer",
			recipient: { agentId: spawned.agent.id, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "supervisor", sessionId: "parent-session" },
			storeRef: { messageId: steered.message.id, sessionPath: persistence.sessionPath },
		});

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();

		expect(readRuntimeMailboxMessage(controlDbPath, runtimeMessageId)).toMatchObject({ status: "delivered" });
		expect(store.getAgent(spawned.agent.id)).toMatchObject({ lifecycle: "completed" });
		expect(store.listMailboxMessages().find((message) => message.id === steered.message.id)).toMatchObject({
			status: "delivered",
		});
	});

	it("marks idle runtime mailbox steer completion after the prompted turn finishes", async () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		const harness = await createHarness({
			multiAgentAgentId: "agent_1",
			multiAgentStore: store,
			persistedSession: true,
		});
		harnesses.push(harness);
		harness.sessionManager.setMetadataControlDbPath(controlDbPath);
		store.setPersistenceSessionManager(harness.sessionManager);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("idle steer done")]);
		const spawned = store.spawnAgent({
			agentType: "verifier",
			cwd: harness.tempDir,
			displayName: "Verifier",
			lifecycle: "starting",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { sessionId: harness.sessionManager.getSessionId() },
		});
		const running = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) throw new Error("expected running transition");
		const steered = store.sendSteering(spawned.agent.id, running.agent.revision, {
			body: "Continue verification while idle",
			fromAgentId: "supervisor",
		});
		expect(steered.ok).toBe(true);
		if (!steered.ok) throw new Error("expected steering to succeed");
		const persistence = store.getPersistenceTarget();
		if (!persistence) throw new Error("expected store persistence target");
		const runtimeMessageId = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "steer",
			recipient: { agentId: spawned.agent.id, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "supervisor", sessionId: "parent-session" },
			storeRef: { messageId: steered.message.id, sessionPath: persistence.sessionPath },
		});

		await vi.advanceTimersByTimeAsync(3_000);
		for (let attempt = 0; attempt < 10 && store.getAgent(spawned.agent.id)?.lifecycle !== "completed"; attempt += 1) {
			await delay(0);
		}
		await harness.session.agent.waitForIdle();

		expect(readRuntimeMailboxMessage(controlDbPath, runtimeMessageId)).toMatchObject({ status: "delivered" });
		expect(store.getAgent(spawned.agent.id)).toMatchObject({ lifecycle: "completed" });
		expect(store.listMailboxMessages().find((message) => message.id === steered.message.id)).toMatchObject({
			status: "delivered",
		});
	});

	it("fails idle runtime mailbox steer state when prompt preflight fails", async () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		const harness = await createHarness({
			multiAgentAgentId: "agent_1",
			multiAgentStore: store,
			persistedSession: true,
			withConfiguredAuth: false,
		});
		harnesses.push(harness);
		harness.sessionManager.setMetadataControlDbPath(controlDbPath);
		store.setPersistenceSessionManager(harness.sessionManager);
		await harness.session.bindExtensions({ controlDbPath });
		const spawned = store.spawnAgent({
			agentType: "verifier",
			cwd: harness.tempDir,
			displayName: "Verifier",
			lifecycle: "starting",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { sessionId: harness.sessionManager.getSessionId() },
		});
		const running = store.transitionAgent(spawned.agent.id, spawned.agent.revision, "running");
		expect(running.ok).toBe(true);
		if (!running.ok) throw new Error("expected running transition");
		const steered = store.sendSteering(spawned.agent.id, running.agent.revision, {
			body: "Continue verification without auth",
			fromAgentId: "supervisor",
		});
		expect(steered.ok).toBe(true);
		if (!steered.ok) throw new Error("expected steering to succeed");
		const persistence = store.getPersistenceTarget();
		if (!persistence) throw new Error("expected store persistence target");
		const runtimeMessageId = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "steer",
			recipient: { agentId: spawned.agent.id, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "supervisor", sessionId: "parent-session" },
			storeRef: { messageId: steered.message.id, sessionPath: persistence.sessionPath },
		});

		await vi.advanceTimersByTimeAsync(3_000);
		for (
			let attempt = 0;
			attempt < 10 && readRuntimeMailboxMessage(controlDbPath, runtimeMessageId)?.status !== "failed";
			attempt += 1
		) {
			await delay(0);
		}

		expect(readRuntimeMailboxMessage(controlDbPath, runtimeMessageId)).toMatchObject({ status: "failed" });
		expect(store.getAgent(spawned.agent.id)).toMatchObject({ lifecycle: "failed" });
		expect(store.listMailboxMessages().find((message) => message.id === steered.message.id)).toMatchObject({
			status: "failed",
		});
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
