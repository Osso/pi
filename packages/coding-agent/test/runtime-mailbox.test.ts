import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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
import { deliverTerminalOutboxProjections, isTerminalOutboxCleanupDue } from "../src/core/terminal-outbox-delivery.ts";
import { legacyMultiAgentStore } from "./helpers/legacy-multi-agent-store.ts";

let storedMessageCounter = 0;
const ignoreRuntimeMailboxSignal = () => {};
process.on("SIGUSR2", ignoreRuntimeMailboxSignal);

function enqueueStoredRuntimeMessage(
	controlDbPath: string,
	input: {
		body: string;
		kind: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["kind"];
		messageId?: string;
		recipient: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["recipient"];
		sender: Parameters<typeof enqueueRuntimeMailboxMessage>[1]["sender"];
		targetCheckpoint?: AgentMailboxMessage["targetCheckpoint"];
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
		targetCheckpoint: input.targetCheckpoint,
		toAgentId: input.recipient.agentId ?? "main",
	});
	return enqueueRuntimeMailboxMessage(controlDbPath, {
		kind: input.kind,
		recipient: input.recipient,
		sender: input.sender,
		storeRef: { messageId, sessionPath },
	});
}

import {
	consumeNotifications,
	createMultiAgentPiRequestHandler,
	createMultiAgentRuntimeHandles,
	type ParentAgentJournalWriter,
	requestAgentSteering,
	waitNotifications,
} from "../extensions/agents-core/src/runtime.ts";
import multiAgentExtension, {
	type AgentDesktopNotification,
	type ChildAgentSessionFactory,
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

type FauxChildOutcome =
	| { lifecycle: "completed"; result?: { summary?: string } }
	| { lifecycle: "failed" | "aborted"; error?: { message: string } }
	| { lifecycle: "waiting_for_input" };

type FauxChildRun = (input: Parameters<ChildAgentSessionFactory>[0]) => Promise<FauxChildOutcome>;

function createTranscriptBackedFauxSessionFactory(store: MultiAgentStore, run: FauxChildRun): ChildAgentSessionFactory {
	return async (input) => {
		const messages: ReturnType<typeof fauxAssistantMessage>[] = [];
		return {
			messages,
			prompt: async () => {
				const outcome = await run(input);
				if (outcome.lifecycle === "completed") {
					if (outcome.result?.summary) messages.push(fauxAssistantMessage(outcome.result.summary));
					return;
				}
				if (outcome.lifecycle === "waiting_for_input") {
					const current = store.getAgent(input.agent.id) ?? input.agent;
					const waiting = legacyMultiAgentStore(store).transitionAgent(
						current.id,
						current.revision,
						"waiting_for_input",
					);
					if (!waiting.ok) throw new Error(`Could not mark ${current.id} waiting`);
					return new Promise<never>(() => {});
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

describe("terminal outbox cleanup schedule", () => {
	it("runs cleanup initially and then no more than once per hour", () => {
		const firstCleanupAt = Date.parse("2026-07-16T12:00:00.000Z");
		expect(isTerminalOutboxCleanupDue(undefined, firstCleanupAt)).toBe(true);
		expect(isTerminalOutboxCleanupDue(firstCleanupAt, firstCleanupAt + 3_000)).toBe(false);
		expect(isTerminalOutboxCleanupDue(firstCleanupAt, firstCleanupAt + 60 * 60 * 1_000 - 1)).toBe(false);
		expect(isTerminalOutboxCleanupDue(firstCleanupAt, firstCleanupAt + 60 * 60 * 1_000)).toBe(true);
	});
});

function runtimeMailboxPrompt(body: string, sessionId = "child-session", agentId = "agent_1"): string {
	return ["From:", `- session: ${sessionId}`, `- agent: ${agentId}`, "", "Message:", body].join("\n");
}

function sharedChannelPrompt(body: string, sessionId = "sender-session"): string {
	return ["From shared channel:", `- session: ${sessionId}`, "- agent: main", "", "Message:", body].join("\n");
}

function createReservedRuntimeAgent(
	store: MultiAgentStore,
	ownerSessionId: string,
	cwd: string,
	input: {
		agentType?: string;
		displayName?: string;
		parentId?: string;
		transcriptSessionId?: string;
		worker?: AgentSnapshot["worker"];
	} = {},
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
		transcript: { sessionId: input.transcriptSessionId ?? ownerSessionId },
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
	input: {
		error?: AgentSnapshot["error"];
		result?: AgentSnapshot["result"];
		terminalLifecycle?: "completed" | "failed";
	},
): AgentSnapshot {
	const finalized = runtime.coordinator.finalizeChild({
		agent: store.getAgent(runtime.agent.id) ?? runtime.agent,
		error: input.error,
		ownership: runtime.ownership,
		result: input.result,
		terminalLifecycle: input.terminalLifecycle ?? "failed",
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
		createChildSession?: ChildAgentSessionFactory;
		desktopNotifier?: (notification: AgentDesktopNotification) => undefined | { close(): void };
		onSessionMessageSent?: (input: { message: AgentMailboxMessage; toSessionId: string }) => void;
	} = {},
): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		appendEntry() {},
		registerCommand(_name: string, _command: Omit<RegisteredCommand, "name" | "sourceInfo">) {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as unknown as ExtensionAPI;
	multiAgentExtension(pi, {
		createChildSession: options.createChildSession,
		desktopNotifier: options.desktopNotifier,
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

	it("does not let a mailbox-started tool turn await its own prompt drain", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		let toolExecutions = 0;
		const tool: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect state",
			parameters: Type.Object({}),
			execute: async () => {
				toolExecutions += 1;
				return { content: [{ type: "text", text: "inspected" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("inspect", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
		]);
		await harness.session.bindExtensions({ controlDbPath });
		enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Inspect the current state",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.session.sessionId },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});

		const drain = harness.session.drainRuntimeCoordination();
		const settled = await Promise.race([drain.then(() => true), delay(500).then(() => false)]);

		expect(settled).toBe(true);
		expect(toolExecutions).toBe(1);
		expect(getUserTexts(harness)).toContain(runtimeMailboxPrompt("Inspect the current state"));
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
		parentSession.setMetadataControlDbPath(controlDbPath);
		childSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const running = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo", {
			agentType: "worker",
			displayName: "Worker",
			transcriptSessionId: childSession.getSessionId(),
		});
		const child = { agent: running.agent };
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: parentSession.getSessionId() },
			process.pid,
			parentSession.getSessionFile(),
		);
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: running.agent.id, sessionId: childSession.getSessionId() },
			process.pid,
		);
		const tools = collectMultiAgentTools(store);
		const steerAgent = tools.get("steer_agent");
		if (!steerAgent) {
			throw new Error("expected steer_agent tool");
		}

		const steered = await steerAgent.execute(
			"steer",
			{ agentId: child.agent.id, expectedRevision: child.agent.revision, message: "Check permissions" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		expect(steered.content).toEqual([{ type: "text", text: "Queued steering for Worker." }]);

		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Check permissions",
				recipient: { agentId: child.agent.id, sessionId: "child-session" },
				sender: { agentId: null, sessionId: "parent-session" },
				status: "pending",
			},
		]);
	});

	it("mirrors dispatched child waiting-for-input notification into the runtime mailbox for the parent main session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		const waitingAgents: AgentSnapshot[] = [];
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const createChildSession = createTranscriptBackedFauxSessionFactory(store, async ({ agent }) => {
			waitingAgents.push(agent);
			return { lifecycle: "waiting_for_input" };
		});
		const tools = collectMultiAgentTools(store, { createChildSession });
		const spawnAgent = tools.get("spawn_agent");
		if (!spawnAgent) {
			throw new Error("expected spawn_agent tool");
		}

		await spawnAgent.execute(
			"spawn",
			{ context: "fresh", displayName: "Worker", prompt: "ask user" },
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
				sender: { agentId: "agent_1", sessionId: "session-agent_1" },
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

	it("disposes Pyrun multi-agent bridge lifecycle mirroring before its session context becomes stale", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const handler = createMultiAgentPiRequestHandler({ store });
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
			"Multi-agent Pi request handler is disposed",
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

	it("rebinds Pyrun multi-agent bridge lifecycle mirroring when a session context is replaced", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const handler = createMultiAgentPiRequestHandler({ store });
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
		const createChildSession: ChildAgentSessionFactory = async ({ agent }) => ({
			messages: [],
			prompt: async () => {
				const current = store.getAgent(agent.id) ?? agent;
				const waiting = legacyMultiAgentStore(store).transitionAgent(
					current.id,
					current.revision,
					"waiting_for_input",
				);
				expect(waiting.ok).toBe(true);
				transitionedToWaiting = true;
				await new Promise<void>(() => {});
			},
			transcript: { path: join(tmpdir(), `${agent.id}.jsonl`), sessionId: `session-${agent.id}` },
		});
		const tools = collectMultiAgentTools(store, { createChildSession });
		const spawnAgent = tools.get("spawn_agent");
		if (!spawnAgent) {
			throw new Error("expected spawn_agent tool");
		}

		await spawnAgent.execute(
			"spawn",
			{ context: "fresh", displayName: "Worker", prompt: "ask user" },
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
				sender: { agentId: "agent_1", sessionId: "session-agent_1" },
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
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const createChildSession = createTranscriptBackedFauxSessionFactory(store, async () => ({
			lifecycle: "waiting_for_input",
		}));
		const tools = collectMultiAgentTools(store, {
			createChildSession,
			desktopNotifier: (notification) => {
				desktopNotifications.push(notification);
				return undefined;
			},
		});
		const spawnAgent = tools.get("spawn_agent");
		if (!spawnAgent) {
			throw new Error("expected spawn_agent tool");
		}

		await spawnAgent.execute(
			"spawn",
			{ context: "fresh", displayName: "Worker", prompt: "ask user" },
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
		const finishDispatch = deferred<void>();
		const createChildSession: ChildAgentSessionFactory = async ({ agent }) => {
			const messages: ReturnType<typeof fauxAssistantMessage>[] = [];
			return {
				messages,
				prompt: async () => {
					const current = store.getAgent(agent.id) ?? agent;
					const waiting = legacyMultiAgentStore(store).transitionAgent(
						current.id,
						current.revision,
						"waiting_for_input",
					);
					expect(waiting.ok).toBe(true);
					await finishDispatch.promise;
					messages.push(fauxAssistantMessage("done"));
				},
				transcript: { path: join(tmpdir(), `${agent.id}.jsonl`), sessionId: `session-${agent.id}` },
			};
		};
		const tools = collectMultiAgentTools(store, {
			createChildSession,
			desktopNotifier: () => ({ close }),
		});
		const spawnAgent = tools.get("spawn_agent");
		const waitAgents = tools.get("wait_agents");
		if (!spawnAgent || !waitAgents) {
			throw new Error("expected spawn_agent and wait_agents tools");
		}

		await spawnAgent.execute(
			"spawn",
			{ context: "fresh", displayName: "Worker", prompt: "ask user" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		await delay(5);
		expect(close).not.toHaveBeenCalled();

		finishDispatch.resolve(undefined);
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
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const createChildSession = createTranscriptBackedFauxSessionFactory(store, async () => ({
			lifecycle: "waiting_for_input",
		}));
		const tools = collectMultiAgentTools(store, {
			createChildSession,
			desktopNotifier: () => ({ close }),
		});
		const spawnAgent = tools.get("spawn_agent");
		if (!spawnAgent) {
			throw new Error("expected spawn_agent tool");
		}

		await spawnAgent.execute(
			"spawn",
			{ context: "fresh", displayName: "Worker", prompt: "ask user" },
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
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const createChildSession = createTranscriptBackedFauxSessionFactory(store, async () => ({
			lifecycle: "waiting_for_input",
		}));
		const tools = collectMultiAgentTools(store, {
			createChildSession,
			desktopNotifier: () => {
				throw new Error("notification failed");
			},
		});
		const spawnAgent = tools.get("spawn_agent");
		if (!spawnAgent) {
			throw new Error("expected spawn_agent tool");
		}

		await spawnAgent.execute(
			"spawn",
			{ context: "fresh", displayName: "Worker", prompt: "ask user" },
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
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const createChildSession = createTranscriptBackedFauxSessionFactory(store, async ({ agent }) => {
			completedAgents.push(agent);
			return { lifecycle: "completed", result: { summary: "tests passed" } };
		});
		const tools = collectMultiAgentTools(store, { createChildSession });
		const spawnAgent = tools.get("spawn_agent");
		if (!spawnAgent) {
			throw new Error("expected spawn_agent tool");
		}

		await spawnAgent.execute(
			"spawn",
			{ context: "fresh", displayName: "Worker", prompt: "run tests" },
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);
		for (let attempt = 0; attempt < 20 && listRuntimeMailboxMessages(controlDbPath).length === 0; attempt += 1) {
			await delay(1);
		}
		expect(completedAgents).toHaveLength(1);

		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Worker completed: tests passed",
				recipient: { agentId: null, sessionId: "parent-session" },
				sender: { agentId: "agent_1", sessionId: "session-agent_1" },
				status: "pending",
			},
		]);
	});

	it("Pyrun multi-agent bridge agents.wait observes the mirrored completion notification", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const createChildSession = createTranscriptBackedFauxSessionFactory(store, async () => ({
			lifecycle: "completed",
			result: { summary: "tests passed" },
		}));
		const handler = createMultiAgentPiRequestHandler({ createChildSession, store }, {
			appendEntry: (customType: string, data?: unknown) => parentSession.appendCustomEntry(customType, data),
		} satisfies ParentAgentJournalWriter);
		const ctx = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });

		await handler(
			{ method: "agents.spawn", params: { context: "fresh", displayName: "Worker", prompt: "run tests" } },
			ctx,
			undefined,
		);
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
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const createChildSession = createTranscriptBackedFauxSessionFactory(store, async () => ({
			lifecycle: "completed",
			result: { summary: "tests passed" },
		}));
		const tools = collectMultiAgentTools(store, { createChildSession });
		const spawnAgent = tools.get("spawn_agent");
		const waitAgents = tools.get("wait_agents");
		if (!spawnAgent || !waitAgents) {
			throw new Error("expected spawn_agent and wait_agents tools");
		}
		const ctx = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });

		await spawnAgent.execute(
			"spawn",
			{ context: "fresh", displayName: "Worker", prompt: "run tests" },
			undefined,
			undefined,
			ctx,
		);
		for (let attempt = 0; attempt < 50 && listRuntimeMailboxMessages(controlDbPath).length === 0; attempt += 1) {
			await delay(1);
		}
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([{ status: "pending" }]);

		const waited = await waitAgents.execute("wait", {}, undefined, undefined, ctx);

		expect(waited.content[0]).toMatchObject({ text: "Worker completed: tests passed" });
		expect(waited.details).toMatchObject({ agent: { result: { summary: "tests passed" } } });
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{ body: "Worker completed: tests passed", status: "delivered" },
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

			const signalListenerCount = process.listenerCount("SIGUSR2");
			let settled = false;
			const waiting = waitAgents
				.execute(
					"wait",
					{},
					undefined,
					undefined,
					createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
				)
				.then((result) => {
					settled = true;
					return result;
				});
			await Promise.resolve();
			expect(process.listenerCount("SIGUSR2")).toBe(signalListenerCount);
			const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
				body: "Need parent review",
				kind: "message",
				recipient: { agentId: null, sessionId: parentSession.getSessionId() },
				sender: { agentId: runtime.agent.id, sessionId: "child-session" },
			});
			await vi.advanceTimersByTimeAsync(2_999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);

			const waited = await waiting;
			expect(waited.content[0]).toMatchObject({
				text: expect.stringContaining("Need parent review"),
			});
			expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
		},
	);

	it("wakes an active wait_agents naturally after successful steering", async () => {
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
		store.setPersistenceSessionManager(parentSession);
		const runtime = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo", {
			transcriptSessionId: childSession.getSessionId(),
		});
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
		const tools = collectMultiAgentTools(store);
		const steerAgent = tools.get("steer_agent");
		const waitAgents = tools.get("wait_agents");
		if (!steerAgent || !waitAgents) throw new Error("expected steering and wait tools");
		const context = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });
		const controller = new AbortController();
		const waiting = waitAgents.execute("wait", {}, controller.signal, undefined, context);
		await Promise.resolve();

		const steered = await steerAgent.execute(
			"steer",
			{
				agentId: runtime.agent.id,
				expectedRevision: store.getAgent(runtime.agent.id)?.revision,
				message: "Check permissions",
			},
			undefined,
			undefined,
			context,
		);

		try {
			const waited = await Promise.race([
				waiting,
				delay(100).then(() => {
					throw new Error("wait_agents did not wake after steering");
				}),
			]);
			expect(controller.signal.aborted).toBe(false);
			expect(steered.content).toEqual([{ type: "text", text: "Queued steering for Verifier." }]);
			expect(waited.content).toEqual([{ type: "text", text: "Woken after steering Verifier." }]);
			expect(waited.details).toMatchObject({ wakeUp: { agentId: runtime.agent.id, kind: "steering" } });
			expect(store.getAgent(runtime.agent.id)).toMatchObject({ lifecycle: "steering_pending" });
			expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
				{
					body: "Check permissions",
					recipient: { agentId: runtime.agent.id, sessionId: childSession.getSessionId() },
					status: "pending",
					storeRef: { sessionPath: parentSession.getSessionFile() },
				},
			]);
			expect(store.listPendingLifecycleNotificationsForAgent(runtime.agent.id, "completed")).toEqual([]);
		} finally {
			controller.abort();
		}
	});

	it("shares transient wake handles with exported interactive steering", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const runtime = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo", {
			transcriptSessionId: "interactive-child-session",
		});
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const context = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });
		const waiting = waitNotifications(store, runtimeHandles, undefined, context);
		await Promise.resolve();

		const steered = requestAgentSteering(
			store,
			{ agentId: runtime.agent.id, message: "Interactive instruction" },
			{ actorAgentId: null, controlDbPath, sessionId: parentSession.getSessionId() },
			runtimeHandles,
		);
		if (!steered.ok) throw new Error(steered.error);
		const waited = consumeNotifications(store, await waiting, context);

		expect(waited.content).toEqual([{ type: "text", text: "Woken after steering Verifier." }]);
		expect(waited.details).toMatchObject({ wakeUp: { agentId: runtime.agent.id, kind: "steering" } });
	});

	it("does not wake for steering accepted after the active-agent snapshot", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const tracked = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo", {
			transcriptSessionId: "tracked-child-session",
		});
		const runtimeHandles = createMultiAgentRuntimeHandles();
		const context = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });
		let settled = false;
		const waiting = waitNotifications(store, runtimeHandles, undefined, context).then((wake) => {
			settled = true;
			return wake;
		});
		await Promise.resolve();
		const untracked = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo", {
			displayName: "Late worker",
			transcriptSessionId: "late-child-session",
		});

		const lateSteering = requestAgentSteering(
			store,
			{ agentId: untracked.agent.id, message: "Late instruction" },
			{ actorAgentId: null, controlDbPath, sessionId: parentSession.getSessionId() },
			runtimeHandles,
		);
		if (!lateSteering.ok) throw new Error(lateSteering.error);
		await Promise.resolve();
		expect(settled).toBe(false);

		const trackedSteering = requestAgentSteering(
			store,
			{ agentId: tracked.agent.id, message: "Tracked instruction" },
			{ actorAgentId: null, controlDbPath, sessionId: parentSession.getSessionId() },
			runtimeHandles,
		);
		if (!trackedSteering.ok) throw new Error(trackedSteering.error);
		expect(await waiting).toEqual({
			kind: "wake_up",
			wakeUp: { agentId: tracked.agent.id, kind: "steering" },
		});
	});

	it("does not retain a stale wake when steering succeeds without an active wait", async () => {
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
		store.setPersistenceSessionManager(parentSession);
		const runtime = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo", {
			transcriptSessionId: childSession.getSessionId(),
		});
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
		const tools = collectMultiAgentTools(store);
		const steerAgent = tools.get("steer_agent");
		const waitAgents = tools.get("wait_agents");
		if (!steerAgent || !waitAgents) throw new Error("expected steering and wait tools");
		const context = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });

		await steerAgent.execute(
			"steer-before-wait",
			{
				agentId: runtime.agent.id,
				expectedRevision: store.getAgent(runtime.agent.id)?.revision,
				message: "First instruction",
			},
			undefined,
			undefined,
			context,
		);
		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "First instruction",
				recipient: { agentId: runtime.agent.id, sessionId: childSession.getSessionId() },
				status: "pending",
			},
		]);

		const controller = new AbortController();
		let settled = false;
		const waiting = waitAgents.execute("wait", {}, controller.signal, undefined, context).then((value) => {
			settled = true;
			return value;
		});
		await delay(20);
		expect(settled).toBe(false);

		await steerAgent.execute(
			"steer-during-wait",
			{
				agentId: runtime.agent.id,
				expectedRevision: store.getAgent(runtime.agent.id)?.revision,
				message: "Second instruction",
			},
			undefined,
			undefined,
			context,
		);

		try {
			const waited = await Promise.race([
				waiting,
				delay(100).then(() => {
					throw new Error("wait_agents did not wake for steering emitted during the active wait");
				}),
			]);
			expect(waited.content).toEqual([{ type: "text", text: "Woken after steering Verifier." }]);
			expect(listRuntimeMailboxMessages(controlDbPath)).toHaveLength(2);
		} finally {
			controller.abort();
		}
	});

	it("preserves completion when steering wakes wait_agents during a terminal race", async () => {
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
		store.setPersistenceSessionManager(parentSession);
		const runtime = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo", {
			transcriptSessionId: childSession.getSessionId(),
		});
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
		const tools = collectMultiAgentTools(store);
		const steerAgent = tools.get("steer_agent");
		const waitAgents = tools.get("wait_agents");
		if (!steerAgent || !waitAgents) throw new Error("expected steering and wait tools");
		const context = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });
		const firstWait = waitAgents.execute("wait-race", {}, undefined, undefined, context);
		await Promise.resolve();

		await steerAgent.execute(
			"steer-race",
			{
				agentId: runtime.agent.id,
				expectedRevision: store.getAgent(runtime.agent.id)?.revision,
				message: "Check the final edge case",
			},
			undefined,
			undefined,
			context,
		);
		const steeringMessage = store
			.listMailboxMessages()
			.find((message) => message.body === "Check the final edge case");
		const steeringPendingAgent = store.getAgent(runtime.agent.id);
		if (!steeringMessage || !steeringPendingAgent) throw new Error("expected pending steering state");
		const delivered = legacyMultiAgentStore(store).ackSteering(
			runtime.agent.id,
			steeringPendingAgent.revision,
			steeringMessage.id,
			"delivered",
		);
		expect(delivered.ok).toBe(true);
		finalizeReservedRuntimeAgent(store, runtime, {
			result: { summary: "tests passed" },
			terminalLifecycle: "completed",
		});

		const wakeResult = await firstWait;
		expect(wakeResult.content).toEqual([{ type: "text", text: "Woken after steering Verifier." }]);
		const completionResult = await waitAgents.execute("wait-completion", {}, undefined, undefined, context);
		expect(completionResult.content).toEqual([{ type: "text", text: "Verifier completed: tests passed" }]);
		expect(completionResult.details).toMatchObject({
			agent: { id: runtime.agent.id, lifecycle: "completed", result: { summary: "tests passed" } },
			message: { status: "pending" },
		});
		expect(store.listPendingLifecycleNotificationsForAgent(runtime.agent.id, "completed")).toEqual([]);
	});

	it("returns terminal state when steering terminalizes before wake_up observation", async () => {
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
		store.setPersistenceSessionManager(parentSession);
		const runtime = createReservedRuntimeAgent(store, parentSession.getSessionId(), "/repo", {
			transcriptSessionId: childSession.getSessionId(),
		});
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
		const tools = collectMultiAgentTools(store);
		const steerAgent = tools.get("steer_agent");
		const waitAgents = tools.get("wait_agents");
		if (!steerAgent || !waitAgents) throw new Error("expected steering and wait tools");
		const context = createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession });
		const waiting = waitAgents.execute("wait-terminal-precedence", {}, undefined, undefined, context);
		await Promise.resolve();

		let terminalized = false;
		const unsubscribe = store.subscribeAgentTransitions((_previous, current) => {
			if (terminalized || current.id !== runtime.agent.id || current.lifecycle !== "steering_pending") return;
			terminalized = true;
			const steeringMessage = store.listMailboxMessages().find((message) => message.body === "Finish now");
			if (!steeringMessage) throw new Error("expected pending steering message");
			const delivered = runtime.coordinator.acknowledgeSteeringDelivery({
				agent: current,
				messageId: steeringMessage.id,
				ownership: runtime.ownership,
			});
			if (!delivered.ok) throw new Error(`could not deliver steering: ${delivered.error}`);
			const finalized = runtime.coordinator.finalizeChild({
				agent: delivered.agent,
				ownership: runtime.ownership,
				result: { summary: "finished during steering" },
				terminalLifecycle: "completed",
			});
			if (!finalized.ok) throw new Error(`could not finalize steering: ${finalized.error}`);
		});

		try {
			await steerAgent.execute(
				"steer-terminal-precedence",
				{ agentId: runtime.agent.id, message: "Finish now" },
				undefined,
				undefined,
				context,
			);
			const completionResult = await waiting;
			expect(completionResult.content).toEqual([
				{ type: "text", text: "Verifier is completed: finished during steering" },
			]);
			expect(completionResult.details).toMatchObject({
				agent: { id: runtime.agent.id, lifecycle: "completed" },
			});
		} finally {
			unsubscribe();
		}
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
		for (let index = 0; index < 20; index += 1) {
			enqueueStoredRuntimeMessage(controlDbPath, {
				body: JSON.stringify({
					agentId: `background_${index}`,
					eventKind: "detached_job_completed",
					type: "multi_agent_terminal",
				}),
				kind: "system",
				messageId: `terminal:background_${index}:2:detached_job_completed`,
				recipient: { agentId: null, sessionId: parentSession.getSessionId() },
				sender: { agentId: `background_${index}`, sessionId: "child-session" },
			});
		}

		await vi.advanceTimersByTimeAsync(30_000);
		expect(settled).toBe(false);
		enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Need parent review",
			kind: "message",
			recipient: { agentId: null, sessionId: parentSession.getSessionId() },
			sender: { agentId: runtime.agent.id, sessionId: "child-session" },
		});
		await vi.advanceTimersByTimeAsync(30_000);

		const waited = await waiting;
		expect(waited.content[0]).toMatchObject({ text: expect.stringContaining("Need parent review") });
	});

	it("wait_agents returns coordination input when no agents are active", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const waitAgents = collectMultiAgentTools(store).get("wait_agents");
		if (!waitAgents) throw new Error("expected wait_agents tool");
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: parentSession.getSessionId() },
			process.pid,
			parentSession.getSessionFile(),
		);
		const messageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Coordination without active agents",
			kind: "message",
			recipient: { agentId: null, sessionId: parentSession.getSessionId() },
			sender: { agentId: "completed-child", sessionId: "child-session" },
		});

		const waited = await waitAgents.execute(
			"wait",
			{},
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);

		expect(waited.content[0]).toMatchObject({ text: expect.stringContaining("Coordination without active agents") });
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
	});

	it("wait_agents returns each distinct coordination message exactly once", async () => {
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

		const firstId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "First coordination message",
			kind: "message",
			recipient: { agentId: null, sessionId: parentSession.getSessionId() },
			sender: { agentId: runtime.agent.id, sessionId: "child-session" },
		});
		const first = await waitAgents.execute("wait", {}, undefined, undefined, context);

		const secondId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Second coordination message",
			kind: "message",
			recipient: { agentId: null, sessionId: parentSession.getSessionId() },
			sender: { agentId: runtime.agent.id, sessionId: "child-session" },
		});
		const second = await waitAgents.execute("wait", {}, undefined, undefined, context);

		expect(first.content[0]).toMatchObject({ text: expect.stringContaining("First coordination message") });
		expect(first.content[0]).not.toMatchObject({ text: expect.stringContaining("Second coordination message") });
		expect(second.content[0]).toMatchObject({ text: expect.stringContaining("Second coordination message") });
		expect(readRuntimeMailboxMessage(controlDbPath, firstId)).toMatchObject({ status: "delivered" });
		expect(readRuntimeMailboxMessage(controlDbPath, secondId)).toMatchObject({ status: "delivered" });
	});

	it("wait_agents returns every coordination message pending at wake", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const parentSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "parent-session" });
		parentSession.setMetadataControlDbPath(controlDbPath);
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
		store.setPersistenceSessionManager(parentSession);
		const waitAgents = collectMultiAgentTools(store).get("wait_agents");
		if (!waitAgents) throw new Error("expected wait_agents tool");
		const recipient = { agentId: null, sessionId: parentSession.getSessionId() };
		registerRuntimeMailboxListener(controlDbPath, recipient, process.pid, parentSession.getSessionFile());
		const messageIds = Array.from({ length: 21 }, (_, index) =>
			enqueueStoredRuntimeMessage(controlDbPath, {
				body: `Pending coordination ${index}`,
				kind: "message",
				recipient,
				sender: { agentId: `child_${index}`, sessionId: "child-session" },
			}),
		);

		const waited = await waitAgents.execute(
			"wait",
			{},
			undefined,
			undefined,
			createRuntimeMailboxContext({ controlDbPath, sessionManager: parentSession }),
		);

		expect(waited.content[0]).toMatchObject({ text: expect.stringContaining("Pending coordination 20") });
		for (const messageId of messageIds) {
			expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
		}
	});

	it("wait_agents returns an eligible shared-channel message and advances its cursor", async () => {
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

		await vi.advanceTimersByTimeAsync(30_000);
		const waited = await waiting;

		expect(waited.content[0]).toMatchObject({ text: expect.stringContaining("Coordination changed") });
		expect(readSharedChannelCursor(controlDbPath, recipient)).toBe(messageId);
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

	it("joins a mailbox drain that changes from idle prompt delivery to active-turn steering", async () => {
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
		let releaseMailboxHandler!: () => void;
		const mailboxHandlerGate = new Promise<void>((resolve) => {
			releaseMailboxHandler = resolve;
		});
		let markMailboxHandlerEntered!: () => void;
		const mailboxHandlerEntered = new Promise<void>((resolve) => {
			markMailboxHandlerEntered = resolve;
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
					pi.on("runtime_mailbox", async () => {
						markMailboxHandlerEntered();
						await mailboxHandlerGate;
						return { handled: false };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("user reply")]);
		enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Child finished while prompt delivery became steering",
			kind: "system",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "agent_1", sessionId: "child-session" },
		});
		const drainableSession = harness.session as unknown as {
			_drainRuntimeMailboxMessages(options: {
				checkpoint?: "after_tool_result";
				triggerIfIdle: boolean;
			}): Promise<boolean>;
		};

		const activePrompt = harness.session.prompt("User turn");
		await preflightEntered;
		const idleDrain = harness.session.drainRuntimeCoordination();
		releasePreflight();
		await mailboxHandlerEntered;
		const checkpointDrain = drainableSession._drainRuntimeMailboxMessages({
			checkpoint: "after_tool_result",
			triggerIfIdle: false,
		});
		releaseMailboxHandler();

		await expect(checkpointDrain).resolves.toBe(true);
		await expect(Promise.all([activePrompt, idleDrain])).resolves.toBeDefined();
	});

	it("delivers next-model-call steering after a tool result before the provider continues", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		const afterToolMessageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Record the completed read",
			kind: "steer",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "supervisor", sessionId: "parent-session" },
			targetCheckpoint: "after_tool_result",
		});
		const nextModelMessageId = enqueueStoredRuntimeMessage(controlDbPath, {
			body: "Use the expanded readability scope",
			kind: "steer",
			recipient: { agentId: null, sessionId: harness.sessionManager.getSessionId() },
			sender: { agentId: "supervisor", sessionId: "parent-session" },
			targetCheckpoint: "next_model_call",
		});
		const agent = harness.session.agent as unknown as {
			prepareNextTurnWithContext?: (turn: unknown, signal: AbortSignal) => Promise<unknown>;
			state: { isStreaming: boolean };
			steer(message: { content: Array<{ text?: string }> }): void;
		};
		agent.state.isStreaming = true;
		const steer = vi.spyOn(agent, "steer");

		await agent.prepareNextTurnWithContext?.(
			{ context: [], toolResults: [{ toolCallId: "read-1" }] },
			new AbortController().signal,
		);

		expect(steer).toHaveBeenCalledTimes(1);
		expect(steer).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [
					{
						type: "text",
						text: [
							runtimeMailboxPrompt("Record the completed read", "parent-session", "supervisor"),
							runtimeMailboxPrompt("Use the expanded readability scope", "parent-session", "supervisor"),
						].join("\n\n"),
					},
				],
			}),
		);
		expect(readRuntimeMailboxMessage(controlDbPath, afterToolMessageId)).toMatchObject({ status: "delivered" });
		expect(readRuntimeMailboxMessage(controlDbPath, nextModelMessageId)).toMatchObject({ status: "delivered" });
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
		const runtimeMessage = listRuntimeMailboxMessages(controlDbPath).find(
			(message) => message.storeRef?.messageId === steered.message.id,
		);
		if (!runtimeMessage) throw new Error("expected automatically mirrored steering message");

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();

		expect(readRuntimeMailboxMessage(controlDbPath, runtimeMessage.id)).toMatchObject({ status: "delivered" });
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
		expect(
			listRuntimeMailboxMessages(controlDbPath).some(
				(message) => message.storeRef?.messageId === steered.message.id,
			),
		).toBe(true);

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
		const runtimeMessage = listRuntimeMailboxMessages(controlDbPath).find(
			(message) => message.storeRef?.messageId === steered.message.id,
		);
		if (!runtimeMessage) throw new Error("expected automatically mirrored steering message");

		await vi.advanceTimersByTimeAsync(30_000);
		for (let attempt = 0; attempt < 10 && store.getAgent(spawned.agent.id)?.lifecycle !== "completed"; attempt += 1) {
			await delay(0);
		}
		await harness.session.agent.waitForIdle();

		expect(readRuntimeMailboxMessage(controlDbPath, runtimeMessage.id)).toMatchObject({ status: "delivered" });
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
		const runtimeMessage = listRuntimeMailboxMessages(controlDbPath).find(
			(message) => message.storeRef?.messageId === steered.message.id,
		);
		if (!runtimeMessage) throw new Error("expected automatically mirrored steering message");

		await vi.advanceTimersByTimeAsync(30_000);

		expect(readRuntimeMailboxMessage(controlDbPath, runtimeMessage.id)).toMatchObject({ status: "pending" });
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

		await vi.advanceTimersByTimeAsync(30_000);
		expect(getUserTexts(harness)).toEqual([]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "pending" });

		await harness.session.bindExtensions({ controlDbPath });
		await vi.advanceTimersByTimeAsync(30_000);
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
			await vi.advanceTimersByTimeAsync(30_000);
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

	it("wakes the idle main session immediately when runtime mailbox delivery is signalled", async () => {
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

		for (let attempt = 0; attempt < 10 && getUserTexts(harness).length === 0; attempt += 1) {
			await delay(0);
		}
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([runtimeMailboxPrompt("Need parent review")]);
		expect(readRuntimeMailboxMessage(controlDbPath, messageId)).toMatchObject({ status: "delivered" });
	});
});
