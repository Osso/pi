import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import {
	claimRuntimeMailboxMessages,
	deliverRuntimeMailboxMessage,
	enqueueRuntimeMailboxMessage,
	enqueueStoredRuntimeMailboxMessage,
	getMultiAgentMailboxMessageStatus,
	getRuntimeProcessInstanceId,
	readMultiAgentState,
	readRuntimeMailboxMessage,
	registerRuntimeMailboxListener,
	takeRuntimeMailboxMessagesForDelivery,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const recipient = { agentId: null, sessionId: "deletion-recipient" };
const sender = { agentId: null, sessionId: "deletion-sender" };

describe("once-only canonical mailbox deletion", () => {
	let directory: string;
	let controlDbPath: string;
	let sessionManager: SessionManager;
	let store: MultiAgentStore;
	let sessionPath: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-mailbox-deletion-"));
		controlDbPath = join(directory, "control.sqlite");
		sessionManager = SessionManager.create(directory, join(directory, "sessions"), { id: recipient.sessionId });
		sessionManager.setMetadataControlDbPath(controlDbPath);
		store = MultiAgentStore.fromSessionManager(sessionManager);
		const persistence = store.getPersistenceTarget();
		if (!persistence) throw new Error("Expected persisted store");
		sessionPath = persistence.sessionPath;
		registerRuntimeMailboxListener(controlDbPath, recipient, process.pid, sessionPath);
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	it("deletes delivery from persistence and projection without status updates resurrecting it", () => {
		const message = store.recordOutboundSessionMessage({
			fromAgentId: "main",
			toAgentId: "main",
			body: "one delivery",
		});
		const id = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "message",
			recipient,
			sender,
			storeRef: { messageId: message.id, sessionPath },
		});
		expect(
			takeRuntimeMailboxMessagesForDelivery(controlDbPath, recipient, () => true).map((item) => item.body),
		).toEqual(["one delivery"]);
		expect(readRuntimeMailboxMessage(controlDbPath, id)).toBeUndefined();
		store.markMailboxMessageDelivered(message.id);
		expect(store.listMailboxMessages()).toEqual([]);
		expect(store.markMailboxMessageFailed(message.id, "late failure")).toBeUndefined();
		expect(readMultiAgentState(controlDbPath, sessionPath)?.mailboxMessages).toEqual([]);
		const restored = MultiAgentStore.fromSessionManager(sessionManager);
		expect(restored.listMailboxMessages()).toEqual([]);
		expect(takeRuntimeMailboxMessagesForDelivery(controlDbPath, recipient, () => true)).toEqual([]);
	});

	it("a stale sender projection cannot recreate a remotely delivered message", () => {
		const message = store.recordOutboundSessionMessage({
			fromAgentId: "main",
			toAgentId: "main",
			body: "remote sender",
		});
		enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "message",
			recipient,
			sender,
			storeRef: { messageId: message.id, sessionPath },
		});
		const staleSender = MultiAgentStore.fromSessionManager(sessionManager);
		expect(takeRuntimeMailboxMessagesForDelivery(controlDbPath, recipient, () => true)).toHaveLength(1);
		expect(staleSender.markMailboxMessageFailed(message.id, "late sender failure")).toBeUndefined();
		expect(staleSender.listMailboxMessages()).toEqual([]);
		store.recordOutboundSessionMessage({ fromAgentId: "main", toAgentId: "main", body: "next independent message" });
		expect(getMultiAgentMailboxMessageStatus(controlDbPath, sessionPath, message.id)).toBeUndefined();
	});

	it("deletes a claimed payload only with its exact claim and payload", () => {
		const message = store.recordOutboundSessionMessage({
			fromAgentId: "main",
			toAgentId: "main",
			body: "claimed delivery",
		});
		const id = enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "message",
			recipient,
			sender,
			storeRef: { messageId: message.id, sessionPath },
		});
		expect(claimRuntimeMailboxMessages(controlDbPath, recipient)).toHaveLength(1);
		expect(deliverRuntimeMailboxMessage(controlDbPath, id, "wrong snapshot")).toBe(false);
		expect(readRuntimeMailboxMessage(controlDbPath, id)?.status).toBe("claimed");
		expect(deliverRuntimeMailboxMessage(controlDbPath, id)).toBe(true);
		expect(readRuntimeMailboxMessage(controlDbPath, id)).toBeUndefined();
		expect(deliverRuntimeMailboxMessage(controlDbPath, id)).toBe(false);
	});

	it("an explicit stored enqueue after delivery creates a new message", () => {
		const input = {
			kind: "message" as const,
			recipient,
			sender,
			storeRef: { messageId: "new-enqueue", sessionPath },
			message: {
				id: "new-enqueue",
				fromAgentId: "main",
				toAgentId: "main",
				kind: "message",
				status: "pending",
				body: "new attempt",
				createdAt: new Date().toISOString(),
			},
		};
		enqueueStoredRuntimeMailboxMessage(controlDbPath, input);
		expect(takeRuntimeMailboxMessagesForDelivery(controlDbPath, recipient, () => true)).toHaveLength(1);
		enqueueStoredRuntimeMailboxMessage(controlDbPath, input);
		expect(takeRuntimeMailboxMessagesForDelivery(controlDbPath, recipient, () => true)).toHaveLength(1);
	});

	it("steering acceptance atomically removes its message and projects running state", () => {
		const processIdentity = JSON.parse(getRuntimeProcessInstanceId());
		const coordinator = new LifecycleCoordinator({
			controlDbPath,
			createAgentId: () => "steered-child",
			now: () => new Date().toISOString(),
			processIdentity,
			sessionPath,
		});
		const prepared = coordinator.prepareChild({
			agentType: "worker",
			cwd: directory,
			displayName: "Steered child",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { sessionId: recipient.sessionId },
		});
		const spawned = coordinator.commitRunningChild(prepared, recipient.sessionId);
		if (!spawned.ok) throw new Error(`Could not create child: ${spawned.error}`);
		store.publishLifecycleCoordinatorSnapshot(spawned.agent);
		const address = { agentId: spawned.agent.id, sessionId: recipient.sessionId };
		registerRuntimeMailboxListener(controlDbPath, address, process.pid, sessionPath);
		const requested = coordinator.requestSteering({
			agent: spawned.agent,
			ownership: spawned.ownership,
			fromAgentId: "supervisor",
			body: "resume child",
			recipient: address,
		});
		if (!requested.ok) throw new Error(`Could not steer child: ${requested.error}`);
		store.publishLifecycleCoordinatorSteering(requested.agent, requested.message);
		expect(takeRuntimeMailboxMessagesForDelivery(controlDbPath, address, () => true)).toHaveLength(1);
		expect(getMultiAgentMailboxMessageStatus(controlDbPath, sessionPath, requested.message.id)).toBeUndefined();
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: spawned.agent.id, lifecycle: "running" },
		]);
		store.restoreFromSessionManager(sessionManager);
		expect(store.getAgent(spawned.agent.id)?.lifecycle).toBe("running");
		expect(store.listMailboxMessages()).toEqual([]);
	});
});
