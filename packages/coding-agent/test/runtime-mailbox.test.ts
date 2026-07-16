import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PERSISTENT_DESKTOP_NOTIFICATION_EXPIRE_TIME_MS } from "../src/core/desktop-notification.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { type AgentMailboxMessage, type AgentSnapshot, MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { readProcessIdentity } from "../src/core/runtime-process.ts";
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
	type readMultiAgentRuntimeOwnership,
	readRuntimeMailboxMessage,
	readSessionHealth,
	readSharedChannelCursor,
	registerRuntimeMailboxListener,
	upsertMultiAgentMailboxMessage,
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { deliverTerminalOutboxProjections } from "../src/core/terminal-outbox-delivery.ts";
import { legacyMultiAgentStore } from "./helpers/legacy-multi-agent-store.ts";

let storedMessageCounter = 0;

function enqueueStoredRuntimeMessage(
	controlDbPath: string,
	input: {
		body: string;
		kind: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["kind"];
		messageId?: string;
		recipient: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["recipient"];
		sender: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["sender"];
	},
): number {
	storedMessageCounter += 1;
	const messageId = input.messageId ?? `runtime_test_message_${storedMessageCounter}`;
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

function createReservedRuntimeAgent(
	store: MultiAgentStore,
	ownerSessionId: string,
	cwd: string,
	input: { agentType?: string; displayName?: string; parentId?: string; worker?: AgentSnapshot["worker"] } = {},
): {
	agent: AgentSnapshot;
	coordinator: LifecycleCoordinator;
	ownership: NonNullable<ReturnType<typeof readMultiAgentRuntimeOwnership>>;
} {
	const persistence = store.getPersistenceTarget();
	if (!persistence) throw new Error("expected store persistence target");
	const coordinator = new LifecycleCoordinator({
		controlDbPath: persistence.controlDbPath,
		createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
		now: () => new Date().toISOString(),
		processIdentity: readProcessIdentity(process.pid),
		sessionPath: persistence.sessionPath,
	});
	const prepared = coordinator.prepareChild({
		agentType: input.agentType ?? "verifier",
		cwd,
		displayName: input.displayName ?? "Verifier",
		parentId: input.parentId,
		permission: { narrowed: true, policy: "on-request" },
		transcript: { sessionId: ownerSessionId },
		worker: input.worker,
	});
	const created = coordinator.commitRunningChild(prepared, ownerSessionId);
	if (!created.ok) throw new Error(`could not create reserved test agent: ${created.error}`);
	store.publishLifecycleCoordinatorSnapshot(created.agent);
	return { agent: created.agent, coordinator, ownership: created.ownership };
}

function spawnReservedRuntimeAgent(store: MultiAgentStore, ownerSessionId: string, cwd: string): AgentSnapshot {
	return createReservedRuntimeAgent(store, ownerSessionId, cwd).agent;
}

function finalizeReservedRuntimeAgent(
	store: MultiAgentStore,
	runtime: ReturnType<typeof createReservedRuntimeAgent>,
	input: { error?: AgentSnapshot["error"]; result?: AgentSnapshot["result"] },
): AgentSnapshot {
	const finalized = runtime.coordinator.finalizeChild({
		agent: runtime.agent,
		error: input.error,
		ownership: runtime.ownership,
		result: input.result,
		terminalLifecycle: "failed",
	});
	if (!finalized.ok) throw new Error(`could not finalize reserved test agent: ${finalized.error}`);
	const persistence = store.getPersistenceTarget();
	if (!persistence) throw new Error("expected store persistence target");
	deliverTerminalOutboxProjections({
		claimId: "runtime-mailbox-test",
		controlDbPath: persistence.controlDbPath,
		now: () => new Date().toISOString(),
		store,
	});
	return finalized.agent;
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

	it("lets extensions consume durable runtime mailbox messages before prompt conversion", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const handled = vi.fn();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("runtime_mailbox", (event) => {
						handled(event.message.body);
						return { handled: true };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "protocol request",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.session.sessionId },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const drainable = harness.session as unknown as {
			_drainRuntimeCoordinationMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		await expect(drainable._drainRuntimeCoordinationMessages({ triggerIfIdle: true })).resolves.toBe(false);
		expect(handled).toHaveBeenCalledWith("protocol request");
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("continues mailbox delivery when terminal outbox projection fails", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const handled = vi.fn();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("runtime_mailbox", (event) => {
						handled(event.message.body);
						return { handled: true };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "independent delivery",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.session.sessionId },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const drainable = harness.session as unknown as {
			_drainRuntimeCoordinationMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
			_drainTerminalOutboxProjections(): void;
		};
		drainable._drainTerminalOutboxProjections = vi.fn(() => {
			throw new Error("poison terminal projection");
		});

		await expect(drainable._drainRuntimeCoordinationMessages({ triggerIfIdle: true })).resolves.toBe(false);
		expect(handled).toHaveBeenCalledWith("independent delivery");
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
	});

	it("keeps readiness-transaction delivery final when a mailbox extension handler throws", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("runtime_mailbox", () => {
						throw new Error("protocol rejected");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "bad protocol request",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.session.sessionId },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const drainable = harness.session as unknown as {
			_drainRuntimeCoordinationMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		await expect(drainable._drainRuntimeCoordinationMessages({ triggerIfIdle: true })).resolves.toBe(false);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
		expect(getUserTexts(harness)).toEqual([]);
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
		const child = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { sessionId: childSession.getSessionId() },
		});
		const tools = collectMultiAgentTools(store);
		const contactParent = tools.get("contact_parent");
		if (!contactParent) {
			throw new Error("expected contact_parent tool");
		}
		expect(tools.has("contact_supervisor")).toBe(false);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider socket closed"));

		await contactParent.execute(
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

		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
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
		const parent = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Parent",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
		});
		const child = legacyMultiAgentStore(store).spawnAgent({
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
		const parent = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Parent",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
		});
		const child = legacyMultiAgentStore(store).spawnAgent({
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
		const parent = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Parent",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
		});
		const child = legacyMultiAgentStore(store).spawnAgent({
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
		const running = createReservedRuntimeAgent(store, childSession.getSessionId(), "/repo", {
			agentType: "worker",
			displayName: "Worker",
		});
		const child = { agent: running.agent };
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
		const child = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
		});
		const waiting = legacyMultiAgentStore(store).transitionAgent(
			child.agent.id,
			child.agent.revision,
			"waiting_for_input",
		);

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

	it("disposes Hostrun lifecycle mirroring before its session context becomes stale", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const handler = createHostrunMultiAgentRequestHandler({ store });
		const staleContext = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });
		let contextReplaced = false;
		Object.defineProperty(staleContext, "controlDbPath", {
			get() {
				if (contextReplaced) throw new Error("stale extension context");
				return controlDbPath;
			},
		});
		await handler({ method: "agents.list", params: {} }, staleContext, undefined);

		handler.dispose();
		contextReplaced = true;
		await expect(handler({ method: "agents.list", params: {} }, staleContext, undefined)).rejects.toThrow(
			"Hostrun multi-agent request handler is disposed",
		);
		const child = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
		});

		expect(() =>
			legacyMultiAgentStore(store).transitionAgent(child.agent.id, child.agent.revision, "waiting_for_input"),
		).not.toThrow();
	});

	it("rebinds Hostrun lifecycle mirroring when a session context is replaced", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const handler = createHostrunMultiAgentRequestHandler({ store });
		const staleContext = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });
		let contextReplaced = false;
		Object.defineProperty(staleContext, "controlDbPath", {
			get() {
				if (contextReplaced) throw new Error("stale extension context");
				return controlDbPath;
			},
		});
		await handler({ method: "agents.list", params: {} }, staleContext, undefined);
		contextReplaced = true;
		const replacementContext = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });
		await handler({ method: "agents.list", params: {} }, replacementContext, undefined);
		const child = legacyMultiAgentStore(store).spawnAgent({
			agentType: "worker",
			cwd: "/repo",
			displayName: "Worker",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
		});

		expect(() =>
			legacyMultiAgentStore(store).transitionAgent(child.agent.id, child.agent.revision, "waiting_for_input"),
		).not.toThrow();
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
			const waiting = legacyMultiAgentStore(store).transitionAgent(agent.id, agent.revision, "waiting_for_input");
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
				const waiting = legacyMultiAgentStore(store).transitionAgent(agent.id, agent.revision, "waiting_for_input");
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
		const steered = legacyMultiAgentStore(store).sendSteering(waitingAgent.id, waitingAgent.revision, {
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

	it("Hostrun agents.wait observes the mirrored completion notification", async () => {
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

	it("wait_agents observes the mirrored completion notification", async () => {
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

	it("wait_agents observes a failed detached Pyrun notification with duration details", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const waitAgents = collectMultiAgentTools(store).get("wait_agents");
		if (!waitAgents) {
			throw new Error("expected wait_agents tool");
		}
		const ctx = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });
		const runtime = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo", {
			agentType: "background",
			displayName: "Pyrun evaluation",
			worker: { adapter: "runtime", handleId: "pyrun" },
		});
		finalizeReservedRuntimeAgent(store, runtime, {
			result: { durationMs: 1234, summary: "Pyrun evaluation failed." },
		});
		const [failureMessage] = store.listPendingLifecycleNotificationsForAgent(runtime.agent.id, "failed");
		const persistence = store.getPersistenceTarget();
		if (!failureMessage || !persistence) {
			throw new Error("expected persisted Pyrun failure notification");
		}
		enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "system",
			recipient: { agentId: null, sessionId: parentSession.getSessionId() },
			sender: { agentId: runtime.agent.id, sessionId: parentSession.getSessionId() },
			storeRef: { messageId: failureMessage.id, sessionPath: persistence.sessionPath },
		});
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([{ status: "pending" }]);

		const waited = await waitAgents.execute("wait", {}, undefined, undefined, ctx);

		expect(waited.content[0]).toMatchObject({ text: "Pyrun evaluation failed. Duration: 1234ms" });
		expect(waited.details).toMatchObject({
			agent: {
				lifecycle: "failed",
				worker: { adapter: "runtime", handleId: "pyrun" },
				result: { durationMs: 1234 },
			},
			message: { body: "Pyrun evaluation failed. Duration: 1234ms", status: "pending" },
		});
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{ body: "Pyrun evaluation failed. Duration: 1234ms", status: "delivered" },
		]);
	});

	it("wait_agents observes a detached Pyrun failure after waiting starts", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const waitAgents = collectMultiAgentTools(store).get("wait_agents");
		if (!waitAgents) {
			throw new Error("expected wait_agents tool");
		}
		const ctx = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });
		const runtime = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo", {
			agentType: "background",
			displayName: "Pyrun evaluation",
			worker: { adapter: "runtime", handleId: "pyrun" },
		});

		const waitedPromise = waitAgents.execute("wait", {}, undefined, undefined, ctx);
		await delay(1);
		finalizeReservedRuntimeAgent(store, runtime, {
			result: { durationMs: 1234, summary: "Pyrun evaluation failed." },
		});
		const [failureMessage] = store.listPendingLifecycleNotificationsForAgent(runtime.agent.id, "failed");
		const persistence = store.getPersistenceTarget();
		if (!failureMessage || !persistence) {
			throw new Error("expected persisted Pyrun failure notification");
		}
		enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "system",
			recipient: { agentId: null, sessionId: parentSession.getSessionId() },
			sender: { agentId: runtime.agent.id, sessionId: parentSession.getSessionId() },
			storeRef: { messageId: failureMessage.id, sessionPath: persistence.sessionPath },
		});

		const waited = await waitedPromise;

		expect(waited.content[0]).toMatchObject({ text: "Pyrun evaluation failed. Duration: 1234ms" });
		expect(waited.details).toMatchObject({
			agent: {
				lifecycle: "failed",
				worker: { adapter: "runtime", handleId: "pyrun" },
				result: { durationMs: 1234 },
			},
			message: { body: "Pyrun evaluation failed. Duration: 1234ms", status: "pending" },
		});
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{ body: "Pyrun evaluation failed. Duration: 1234ms", status: "delivered" },
		]);
	});

	it.skipIf(process.platform === "win32")(
		"wait_agents wakes for a deliverable runtime mailbox message without consuming transport delivery",
		async () => {
			tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
			const controlDbPath = getControlDbPath(tempDir);
			const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
			parentSession.setMetadataControlDbPath(controlDbPath);
			const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
			store.setPersistenceSessionManager(parentSession);
			const runtime = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo");
			const waitAgents = collectMultiAgentTools(store).get("wait_agents");
			if (!waitAgents) throw new Error("expected wait_agents tool");
			registerRuntimeMailboxListener(
				controlDbPath,
				{ agentId: null, sessionId: parentSession.getSessionId() },
				process.pid,
				parentSession.getSessionFile(),
			);

			const waiting = waitAgents.execute(
				"wait",
				{},
				undefined,
				undefined,
				createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
			);
			await delay(1);
			const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
				body: "Need parent review",
				kind: "message",
				recipient: { agentId: null, sessionId: parentSession.getSessionId() },
				sender: { agentId: runtime.agent.id, sessionId: "child-session" },
			});

			const waited = await waiting;

			expect(waited.content[0]).toMatchObject({ text: "Mailbox or shared-channel message received." });
			expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "pending" });
		},
	);

	it("wait_agents ignores outbound steering to the selected child until supervisor coordination arrives", async () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		const childSession = SessionManager.create(tempDir, join(tempDir, "sessions"), {
			id: "child-session",
			isSubagent: true,
			parentSession: parentSession.getSessionFile(),
			subagentName: "Worker",
		});
		parentSession.setMetadataControlDbPath(controlDbPath);
		childSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		// The UI has selected the child, so the store persistence and the incoming
		// context both point at the child rather than the main supervisor session.
		store.setPersistenceSessionManager(childSession);
		const runtime = createReservedRuntimeAgent(store, childSession.getSessionId(), "/repo");
		const tools = collectMultiAgentTools(store);
		const steerAgent = tools.get("steer_agent");
		const waitAgents = tools.get("wait_agents");
		if (!steerAgent || !waitAgents) throw new Error("expected steering and wait tools");
		const supervisorContext = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });

		// Main and child mailbox listeners are registered under the same process.
		// Only the main listener is registered with agentId null; the resolver must
		// pick it by exact process identity regardless of mutable persistence.
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: parentSession.getSessionId() },
			process.pid,
			parentSession.getSessionFile(),
		);
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: runtime.agent.id, sessionId: childSession.getSessionId() },
			process.pid,
		);

		await steerAgent.execute(
			"steer",
			{ agentId: runtime.agent.id, expectedRevision: runtime.agent.revision, message: "Check permissions" },
			undefined,
			undefined,
			supervisorContext,
		);
		const steeringMessages = listRuntimeMailboxMessages(controlDbPath);
		expect(steeringMessages).toMatchObject([
			{
				recipient: { agentId: runtime.agent.id, sessionId: childSession.getSessionId() },
				sender: { agentId: "supervisor", sessionId: parentSession.getSessionId() },
				status: "pending",
			},
		]);
		const steerMessageId = steeringMessages[0].id;

		let selectedChildIdentityRead = false;
		const selectedChildSessionManager = {
			getSessionId: () => childSession.getSessionId(),
			isSubagentSession: () => false,
		} as unknown as SessionManager;
		const selectedChildContext = createRuntimeMailboxContext({
			controlDbPath,
			sessionManager: selectedChildSessionManager,
		});
		Object.defineProperty(selectedChildContext, "multiAgentAgentId", {
			get: () => {
				if (!selectedChildIdentityRead) {
					selectedChildIdentityRead = true;
					return undefined;
				}
				return runtime.agent.id;
			},
		});

		let settled = false;
		const waiting = waitAgents.execute("wait", {}, undefined, undefined, selectedChildContext).then((result) => {
			settled = true;
			return result;
		});
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(3_000);
		// Pending outbound steering targets the child, not the main listener.
		expect(settled).toBe(false);

		const inboundMessageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Need parent review",
			kind: "message",
			recipient: { agentId: null, sessionId: parentSession.getSessionId() },
			sender: { agentId: runtime.agent.id, sessionId: childSession.getSessionId() },
		});
		await vi.advanceTimersByTimeAsync(3_000);

		const waited = await waiting;
		expect(waited.content[0]).toMatchObject({ text: "Mailbox or shared-channel message received." });
		// Neither transport row is consumed by the wake.
		expect(readRuntimeMailboxMessage(controlDbPath, inboundMessageId)).toMatchObject({ status: "pending" });
		expect(readRuntimeMailboxMessage(controlDbPath, steerMessageId)).toMatchObject({ status: "pending" });
	});

	it("wait_agents ignores pending terminal transport rows until actionable coordination arrives", async () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const runtime = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo");
		const waitAgents = collectMultiAgentTools(store).get("wait_agents");
		if (!waitAgents) throw new Error("expected wait_agents tool");
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: parentSession.getSessionId() },
			process.pid,
			parentSession.getSessionFile(),
		);
		const context = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });
		let settled = false;
		const waiting = waitAgents.execute("wait", {}, undefined, undefined, context).then((result) => {
			settled = true;
			return result;
		});
		await Promise.resolve();
		enqueueStoredRuntimeMessage(controlDbPath, {
			body: JSON.stringify({
				agentId: "background_1",
				eventKind: "detached_job_completed",
				type: "multi_agent_terminal",
			}),
			kind: "system",
			messageId: "terminal:background_1:2:detached_job_completed",
			recipient: { agentId: null, sessionId: parentSession.getSessionId() },
			sender: { agentId: "background_1", sessionId: "child-session" },
		});

		await vi.advanceTimersByTimeAsync(3_000);
		expect(settled).toBe(false);
		enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Need parent review",
			kind: "message",
			recipient: { agentId: null, sessionId: parentSession.getSessionId() },
			sender: { agentId: runtime.agent.id, sessionId: "child-session" },
		});
		await vi.advanceTimersByTimeAsync(3_000);

		const waited = await waiting;
		expect(waited.content[0]).toMatchObject({ text: "Mailbox or shared-channel message received." });
	});

	it("wait_agents wakes for an eligible shared-channel message without advancing its cursor", async () => {
		vi.useFakeTimers();
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo");
		const waitAgents = collectMultiAgentTools(store).get("wait_agents");
		if (!waitAgents) throw new Error("expected wait_agents tool");
		const recipient = { agentId: null, sessionId: parentSession.getSessionId() };
		registerRuntimeMailboxListener(controlDbPath, recipient, process.pid, parentSession.getSessionFile());
		const initialCursor = initializeSharedChannelCursorAtTail(controlDbPath, recipient);
		const waiting = waitAgents.execute(
			"wait",
			{},
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		await Promise.resolve();
		const messageId = postSharedChannelMessage(controlDbPath, {
			body: "Coordination changed",
			sender: { agentId: null, sessionId: "sender-session" },
		});

		await vi.advanceTimersByTimeAsync(3_000);
		const waited = await waiting;

		expect(waited.content[0]).toMatchObject({ text: "Mailbox or shared-channel message received." });
		expect(readSharedChannelCursor(controlDbPath, recipient)).toBe(initialCursor);
		expect(messageId).toBeGreaterThan(initialCursor);
	});

	it("wait_agents observes failed agents with result file references", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const waitAgents = collectMultiAgentTools(store).get("wait_agents");
		if (!waitAgents) {
			throw new Error("expected wait_agents tool");
		}

		const runtime = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo", {
			agentType: "worker",
			displayName: "Worker",
			worker: { adapter: "runtime", handleId: "other" },
		});

		const waitedPromise = waitAgents.execute(
			"wait",
			{},
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		await delay(1);
		finalizeReservedRuntimeAgent(store, runtime, {
			error: { message: "tests failed" },
			result: {
				durationMs: 1234,
				fileRefs: [{ label: "Worker output", path: "/tmp/worker-failure.log" }],
				summary: "tests failed",
			},
		});

		const waited = await waitedPromise;

		expect(waited.content[0]).toMatchObject({ text: "Worker failed: tests failed. Duration: 1234ms" });
		expect(waited.details).toMatchObject({
			message: {
				body: "Worker failed: tests failed. Duration: 1234ms",
				fileRefs: [{ label: "Worker output", path: "/tmp/worker-failure.log" }],
				status: "pending",
			},
		});
		expect(store.listPendingLifecycleNotificationsForAgent(runtime.agent.id, "failed")).toHaveLength(0);
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

		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: "parent-session" }, process.pid);
		const claimed = claimRuntimeMailboxMessages(controlDbPath, { agentId: null, sessionId: "parent-session" });
		expect(claimed).toHaveLength(1);

		consumeRuntimeMailboxMessageByStoreRef(controlDbPath, { messageId, sessionPath });

		expect(readRuntimeMailboxMessage(controlDbPath, runtimeMessageId)).toMatchObject({ status: "delivered" });
	});

	it("queues shared channel chatter when idle delivery races a newly started turn", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("user reply"), fauxAssistantMessage("channel reply")]);
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

		const activePrompt = harness.session.prompt("User turn");
		const queued = await drainableSession._drainSharedChannelMessages({ triggerIfIdle: true });
		await activePrompt;

		expect(queued).toBe(false);
		expect(getUserTexts(harness)).toEqual([
			"User turn",
			[
				sharedChannelPrompt("First shared status?", "sender-session-a"),
				sharedChannelPrompt("Second shared status?", "sender-session-b"),
			].join("\n\n"),
		]);
		expect(
			readSharedChannelCursor(controlDbPath, { agentId: null, sessionId: harness.sessionManager.getSessionId() }),
		).toBe(messageId);
	});

	it("marks post-run shared channel follow-ups as extension input", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("user reply"), fauxAssistantMessage("channel reply")]);
		const sharedPrompt = sharedChannelPrompt("Post-run shared status?");
		const promptableSession = harness.session as unknown as {
			_sendSharedChannelPrompt(prompt: string, options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		const activePrompt = harness.session.prompt("User turn");
		const queued = await promptableSession._sendSharedChannelPrompt(sharedPrompt, { triggerIfIdle: false });
		await activePrompt;

		expect(queued).toBe(true);
		expect(getUserTexts(harness)).toEqual(["User turn", sharedPrompt]);
		const userMessages = harness.session.messages.filter((message) => message.role === "user");
		expect(userMessages[1]).toMatchObject({ inputSource: "extension" });
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

	it("delivers pending runtime mailbox messages directly after the session becomes idle", async () => {
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
		await harness.session.drainRuntimeCoordination();
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["hello", runtimeMailboxPrompt("Child finished tests")]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
	});

	it("leaves runtime mailbox messages pending instead of queuing them during post-turn coordination", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Child finished while the current turn was ending",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const drainableSession = harness.session as unknown as {
			_drainRuntimeMailboxMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
		};

		const queued = await drainableSession._drainRuntimeMailboxMessages({ triggerIfIdle: false });

		expect(queued).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "pending" });
	});

	it("marks runtime mailbox messages delivered in the transaction that reads them for idle delivery", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Child finished before idle delivery",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const drainableSession = harness.session as unknown as {
			_drainRuntimeMailboxMessages(options: { triggerIfIdle: boolean }): Promise<boolean>;
			_promptTurn(text: string, options: unknown, releaseTurnStart: () => void): Promise<void>;
		};
		let statusAtPromptEntry: string | undefined;
		drainableSession._promptTurn = async (_text, _options, releaseTurnStart) => {
			statusAtPromptEntry = readRuntimeMailboxMessage(controlDbPath, messageId)?.status;
			releaseTurnStart();
		};

		await drainableSession._drainRuntimeMailboxMessages({ triggerIfIdle: true });

		expect(statusAtPromptEntry).toBe("delivered");
	});

	it("steers idle delivery when another turn starts before the turn-start lock is acquired", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		let releasePreflight!: () => void;
		const preflightGate = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		let markPreflightEntered!: () => void;
		const preflightEntered = new Promise<void>((resolve) => {
			markPreflightEntered = resolve;
		});
		let firstTurn = true;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						if (!firstTurn) return;
						firstTurn = false;
						markPreflightEntered();
						await preflightGate;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("user reply"), fauxAssistantMessage("mailbox reply")]);
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Child finished while another turn was starting",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});

		const activePrompt = harness.session.prompt("User turn");
		await preflightEntered;
		const drain = harness.session.drainRuntimeCoordination();
		releasePreflight();

		await expect(Promise.all([activePrompt, drain])).resolves.toBeDefined();
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([
			"User turn",
			runtimeMailboxPrompt("Child finished while another turn was starting"),
		]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
	});

	it("steers checkpoint-eligible runtime mailbox messages into an active turn", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Child finished during the active turn",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const drainableSession = harness.session as unknown as {
			_drainRuntimeMailboxMessages(options: {
				checkpoint: "next_model_call";
				triggerIfIdle: boolean;
			}): Promise<boolean>;
			agent: {
				state: { isStreaming: boolean };
				steer(message: { content: Array<{ text?: string }> }): void;
			};
		};
		drainableSession.agent.state.isStreaming = true;
		const steer = vi.spyOn(drainableSession.agent, "steer");

		const queued = await drainableSession._drainRuntimeMailboxMessages({
			checkpoint: "next_model_call",
			triggerIfIdle: false,
		});

		expect(queued).toBe(true);
		expect(steer).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [{ type: "text", text: runtimeMailboxPrompt("Child finished during the active turn") }],
				inputSource: "extension",
				role: "user",
			}),
		);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
	});

	it("interrupts model thinking for terminal runtime mailbox notifications", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		let markRequestStarted!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			markRequestStarted = resolve;
		});
		harness.setResponses([
			async (_context, options) => {
				markRequestStarted();
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("Interrupted", { stopReason: "aborted" });
			},
			fauxAssistantMessage("Completion handled"),
		]);

		const activePrompt = harness.session.prompt("Wait for completion");
		await requestStarted;
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: JSON.stringify({
				agentId: "agent_1",
				eventKind: "agent_completed",
				type: "multi_agent_terminal",
			}),
			kind: "system",
			messageId: "terminal:agent_1:2:agent_completed",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const drainableSession = harness.session as unknown as {
			_drainRuntimeMailboxMessages(options: {
				checkpoint: "next_model_call";
				triggerIfIdle: boolean;
			}): Promise<boolean>;
		};

		await drainableSession._drainRuntimeMailboxMessages({
			checkpoint: "next_model_call",
			triggerIfIdle: false,
		});
		const outcome = await Promise.race([
			activePrompt.then(() => "completed"),
			new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 200)),
		]);

		expect(outcome).toBe("completed");
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
		expect(getUserTexts(harness)).toContain(
			runtimeMailboxPrompt(
				JSON.stringify({
					agentId: "agent_1",
					eventKind: "agent_completed",
					type: "multi_agent_terminal",
				}),
			),
		);
	});

	it("does not read runtime mailbox messages when the session is already streaming without a checkpoint", async () => {
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
			agent: { state: { isStreaming: boolean } };
		};
		drainableSession.agent.state.isStreaming = true;

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
		const running = spawnReservedRuntimeAgent(store, harness.sessionManager.getSessionId(), harness.tempDir);
		const spawned = { agent: running };
		const steered = legacyMultiAgentStore(store).sendSteering(running.id, running.revision, {
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

	it("retries a steered parent terminal result after its active child completes", async () => {
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
		harness.setResponses([fauxAssistantMessage("initial reply"), fauxAssistantMessage("preserved parent result")]);
		const parent = createReservedRuntimeAgent(store, harness.sessionManager.getSessionId(), harness.tempDir);
		const child = createReservedRuntimeAgent(store, harness.sessionManager.getSessionId(), harness.tempDir, {
			parentId: parent.agent.id,
		});
		const steered = legacyMultiAgentStore(store).sendSteering(parent.agent.id, parent.agent.revision, {
			body: "Complete after child",
			fromAgentId: "supervisor",
		});
		expect(steered.ok).toBe(true);
		if (!steered.ok) throw new Error("expected steering to succeed");
		const persistence = store.getPersistenceTarget();
		if (!persistence) throw new Error("expected store persistence target");
		enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "steer",
			recipient: { agentId: parent.agent.id, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "supervisor", sessionId: "parent-session" },
			storeRef: { messageId: steered.message.id, sessionPath: persistence.sessionPath },
		});

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();
		expect(store.getAgent(parent.agent.id)).toMatchObject({ lifecycle: "running" });

		finalizeReservedRuntimeAgent(store, child, { result: { summary: "child done" } });
		expect(store.getAgent(parent.agent.id)).toMatchObject({
			lifecycle: "completed",
			result: { summary: "preserved parent result" },
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
		const running = spawnReservedRuntimeAgent(store, harness.sessionManager.getSessionId(), harness.tempDir);
		const spawned = { agent: running };
		const steered = legacyMultiAgentStore(store).sendSteering(running.id, running.revision, {
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

	it("keeps idle runtime mailbox steer pending when prompt authentication is unavailable", async () => {
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
		const running = spawnReservedRuntimeAgent(store, harness.sessionManager.getSessionId(), harness.tempDir);
		const spawned = { agent: running };
		const steered = legacyMultiAgentStore(store).sendSteering(running.id, running.revision, {
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

		expect(readRuntimeMailboxMessage(controlDbPath, runtimeMessageId)).toMatchObject({ status: "pending" });
		expect(store.getAgent(spawned.agent.id)).toMatchObject({ lifecycle: "steering_pending" });
		expect(store.listMailboxMessages().find((message) => message.id === steered.message.id)).toMatchObject({
			status: "pending",
		});
	});

	it("does not claim mailbox messages before listener binding", async () => {
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
		expect(getUserTexts(harness)).toEqual([]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "pending" });

		await harness.session.bindExtensions({ controlDbPath });
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
