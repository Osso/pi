import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMultiAgentPiRequestHandler,
	type MultiAgentPiRequestHandler,
} from "../extensions/agents-core/src/runtime.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { type AgentSnapshot, MultiAgentStore } from "../src/core/multi-agent-store.ts";
import {
	getRuntimeProcessInstanceId,
	markRuntimeMailboxMessageDelivered,
	listRuntimeMailboxMessagesForSession,
	type RuntimeMailboxMessage,
	registerRuntimeMailboxListener,
} from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

const now = "2026-10-08T12:00:00.000Z";

function insertTransport(
	controlDbPath: string,
	sessionPath: string,
	messageId: string,
	fields: Record<string, unknown>,
) {
	const db = createSqliteDatabase(controlDbPath);
	try {
		db.prepare(
			"INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at) VALUES (?, ?, ?, ?)",
		).run(
			sessionPath,
			messageId,
			JSON.stringify({
				body: "history",
				createdAt: now,
				kind: "system",
				recipientAgentId: "other-recipient",
				recipientSessionId: "other-runtime",
				senderAgentId: "agent-child",
				senderSessionId: "other-sender-runtime",
				status: "pending",
				...fields,
			}),
			now,
		);
	} finally {
		db.close();
	}
}

function terminalBody(agent: AgentSnapshot, fields: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "multi_agent_terminal",
		agentId: agent.id,
		terminalRevision: agent.revision,
		...fields,
	});
}

describe("production lifecycle mirror session scope", () => {
	let directory: string;
	let controlDbPath: string;
	let sessionPath: string;
	let store: MultiAgentStore;
	let agent: AgentSnapshot;
	let ctx: ExtensionContext;
	const handlers: MultiAgentPiRequestHandler[] = [];

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now);
		directory = mkdtempSync(join(tmpdir(), "pi-lifecycle-mirror-scope-"));
		controlDbPath = join(directory, "control.sqlite");
		const sessionManager = SessionManager.create(directory, join(directory, "sessions"), { id: "owner-runtime" });
		sessionManager.setMetadataControlDbPath(controlDbPath);
		store = new MultiAgentStore({ now: () => now });
		store.setPersistenceSessionManager(sessionManager);
		const persistence = store.getPersistenceTarget();
		if (!persistence) throw new Error("Expected persisted mirror store");
		sessionPath = persistence.sessionPath;
		const runtimeInstanceId = getRuntimeProcessInstanceId();
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: "owner-runtime" },
			process.pid,
			sessionPath,
			{
				runtimeInstanceId,
			},
		);
		const coordinator = new LifecycleCoordinator({
			controlDbPath,
			createAgentId: () => "agent-child",
			now: () => now,
			processIdentity: JSON.parse(runtimeInstanceId),
			sessionPath,
		});
		const failed = coordinator.commitFailedChild(
			coordinator.prepareChild({
				agentType: "worker",
				cwd: directory,
				displayName: "Worker",
				permission: { narrowed: true, policy: "on-request" },
				transcript: { sessionId: "child-runtime" },
			}),
			{ code: "runtime_spawn_failed", message: "Child construction failed" },
		);
		if (!failed.ok) throw new Error(`Could not create failed child: ${failed.error}`);
		agent = failed.agent;
		ctx = { controlDbPath, sessionManager } as unknown as ExtensionContext;
		const handler = createMultiAgentPiRequestHandler({ store });
		handlers.push(handler);
		await handler({ method: "agents.list", params: {} }, ctx, undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		for (const handler of handlers.splice(0)) handler.dispose();
		rmSync(directory, { recursive: true, force: true });
	});

	it.each(["pending", "claimed", "failed"] as const)(
		"does not duplicate a detached terminal notification after its %s transport is deleted",
		async (status) => {
			insertTransport(controlDbPath, sessionPath, "existing-terminal", { body: terminalBody(agent), status });
			const before = listRuntimeMailboxMessagesForSession(controlDbPath, sessionPath);
			const terminal = { ...agent, detached: true };
			store.publishTerminalOutboxSnapshot(terminal);
			expect(listRuntimeMailboxMessagesForSession(controlDbPath, sessionPath)).toEqual(before);
			markRuntimeMailboxMessageDelivered(controlDbPath, before[0].id);
			expect(listRuntimeMailboxMessagesForSession(controlDbPath, sessionPath)).toEqual([]);

			const rebound = createMultiAgentPiRequestHandler({ store });
			handlers.push(rebound);
			await rebound({ method: "agents.list", params: {} }, ctx, undefined);
			expect(listRuntimeMailboxMessagesForSession(controlDbPath, sessionPath)).toEqual([]);
		},
	);

	const mismatches = ["sender", "kind", "body", "type", "agent", "revision", "session"] as const;
	it.each(mismatches)("mirrors an attended notification regardless of unrelated transport %s", (mismatch) => {
		const fields: Record<string, unknown> = { body: terminalBody(agent) };
		if (mismatch === "sender") fields.senderAgentId = "different-agent";
		if (mismatch === "kind") fields.kind = "message";
		if (mismatch === "body") fields.body = "not JSON";
		if (mismatch === "type") fields.body = terminalBody(agent, { type: "other-protocol" });
		if (mismatch === "agent") fields.body = terminalBody(agent, { agentId: "different-agent" });
		if (mismatch === "revision") fields.body = terminalBody(agent, { terminalRevision: agent.revision - 1 });
		insertTransport(
			controlDbPath,
			mismatch === "session" ? `${sessionPath}.unrelated` : sessionPath,
			"nonmatch",
			fields,
		);
		store.publishTerminalOutboxSnapshot(agent);
		const messages = listRuntimeMailboxMessagesForSession(controlDbPath, sessionPath);
		const mirrored = messages.filter((message) => message.storeRef.messageId !== "nonmatch");
		expect(mirrored).toHaveLength(1);
		expect(mirrored[0]).toMatchObject({
			body: "Worker failed: Child construction failed",
			kind: "system",
			recipient: { agentId: null, sessionId: "owner-runtime" },
			sender: { agentId: agent.id, sessionId: "child-runtime" },
			status: "pending",
			storeRef: { sessionPath },
		});
	});

	it("mirrors and rebinds without parsing unrelated addressed history", async () => {
		for (let index = 0; index < 128; index += 1) {
			insertTransport(controlDbPath, `${sessionPath}.history-${index}`, `history-${index}`, {
				body: "x".repeat(64 * 1024),
			});
		}
		insertTransport(controlDbPath, `${sessionPath}.malformed`, "malformed-history", { body: 42 });
		expect(() => store.publishTerminalOutboxSnapshot(agent)).not.toThrow();
		const messages = listRuntimeMailboxMessagesForSession(controlDbPath, sessionPath);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			recipient: { agentId: null, sessionId: "owner-runtime" },
			sender: { agentId: agent.id, sessionId: "child-runtime" },
			status: "pending",
		} satisfies Partial<RuntimeMailboxMessage>);
		const rebound = createMultiAgentPiRequestHandler({ store });
		handlers.push(rebound);
		await expect(rebound({ method: "agents.list", params: {} }, ctx, undefined)).resolves.toBeDefined();
		expect(listRuntimeMailboxMessagesForSession(controlDbPath, sessionPath)).toEqual(messages);
	});
});
