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
	writeSessionMetadata,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import multiAgentExtension, { type ChildAgentDispatcher } from "../src/extensions/multi-agent.ts";
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
	options: { dispatcher?: ChildAgentDispatcher } = {},
): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerCommand(_name: string, _command: Omit<RegisteredCommand, "name" | "sourceInfo">) {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool as RegisteredTool);
		},
	} as ExtensionAPI;
	multiAgentExtension(pi, { dispatcher: options.dispatcher, store });
	return tools;
}

function createRuntimeMailboxContext(input: {
	controlDbPath: string;
	sessionManager: SessionManager;
}): ExtensionContext {
	return {
		controlDbPath: input.controlDbPath,
		cwd: "/repo",
		hasUI: false,
		isIdle: () => true,
		mode: "print",
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
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
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
			createRuntimeMailboxContext({ controlDbPath, sessionManager: childSession }),
		);

		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Need scope",
				recipient: { agentId: null, sessionId: "parent-session" },
				sender: { agentId: child.agent.id, sessionId: "child-session" },
				status: "pending",
			},
		]);
	});

	it("sends direct messages to an explicit runtime session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
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
			createRuntimeMailboxContext({ controlDbPath, sessionManager: senderSession }),
		);

		expect(listRuntimeMailboxMessages(controlDbPath)).toMatchObject([
			{
				body: "Hello other session",
				recipient: { agentId: null, sessionId: "target-session" },
				sender: { agentId: parent.agent.id, sessionId: "sender-session" },
				status: "pending",
			},
		]);
	});

	it("sends direct messages to an explicit main runtime session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const senderSession = SessionManager.create(tempDir, join(tempDir, "sessions"), { id: "sender-session" });
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
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
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
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
				recipient: { agentId: null, sessionId: "child-session" },
				sender: { agentId: "supervisor", sessionId: "parent-session" },
				status: "pending",
			},
		]);
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
		const store = new MultiAgentStore({ now: () => "2026-07-01T00:00:00.000Z" });
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

	it("drains claimed runtime mailbox messages at the end of a turn", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-runtime-mailbox-"));
		const controlDbPath = getControlDbPath(tempDir);
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({ controlDbPath });
		harness.setResponses([fauxAssistantMessage("initial reply"), fauxAssistantMessage("mailbox reply")]);
		const messageId = enqueueRuntimeMailboxMessage(controlDbPath, {
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
		const messageId = enqueueRuntimeMailboxMessage(controlDbPath, {
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
		const messageId = enqueueRuntimeMailboxMessage(controlDbPath, {
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
		const messageId = enqueueRuntimeMailboxMessage(controlDbPath, {
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
		const messageId = enqueueRuntimeMailboxMessage(controlDbPath, {
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
