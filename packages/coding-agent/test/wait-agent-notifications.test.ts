import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeNotifications, waitNotifications } from "../extensions/agents-core/src/index.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { getControlDbPath } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";
import { legacyMultiAgentStore } from "./helpers/legacy-multi-agent-store.ts";

const tempDirs: string[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime("2026-07-20T00:00:00.000Z");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { force: true, recursive: true });
});

function createPersistedSession(): { session: SessionManager; store: MultiAgentStore } {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-wait-notifications-"));
	tempDirs.push(tempDir);
	const session = SessionManager.create("/repo", join(tempDir, "sessions"));
	session.setMetadataControlDbPath(getControlDbPath(tempDir));
	const store = new MultiAgentStore({ now: () => "2026-07-20T00:00:00.000Z" });
	store.setPersistenceSessionManager(session);
	return { session, store };
}

function createPersistedStore(): MultiAgentStore {
	return createPersistedSession().store;
}

function completeAgent(store: MultiAgentStore, displayName: string): void {
	const spawned = legacyMultiAgentStore(store).spawnAgent({
		agentType: "implement",
		cwd: "/repo",
		displayName,
		permission: { narrowed: true, policy: "on-request" },
	});
	const completed = legacyMultiAgentStore(store).transitionAgent(
		spawned.agent.id,
		spawned.agent.revision,
		"completed",
		{ result: { summary: "done" } },
	);
	if (!completed.ok) throw new Error("expected completed agent fixture");
}

function createStoreWithCompletedAgent(): MultiAgentStore {
	const store = createPersistedStore();
	completeAgent(store, "Worker");
	return store;
}

// Clones the first completed agent and its pending notification, matching production volume
// (agent-server world-of-osso: 7,069 agent rows, 138 mailbox rows) in one transaction.
function seedCompletedHistory(session: SessionManager, counts: { historyAgents: number; pendingAgents: number }): void {
	const sessionPath = session.getSessionFile();
	const controlDbPath = session.getMetadataControlDbPath();
	if (!sessionPath || !controlDbPath) throw new Error("expected persisted session");
	const db = createSqliteDatabase(controlDbPath);
	try {
		const template = db
			.prepare("SELECT agent_id, data FROM multi_agent_agents WHERE session_path = ?")
			.get(sessionPath) as { agent_id: string; data: string };
		const message = db
			.prepare("SELECT data FROM multi_agent_mailbox_messages WHERE session_path = ?")
			.get(sessionPath) as { data: string };
		const insertAgent = db.prepare(`INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at)
			VALUES (?, ?, json_set(?, '$.id', ?, '$.displayName', ?), '2026-07-20T00:00:00.000Z')`);
		const insertOwner = db.prepare(`INSERT INTO multi_agent_runtime_owners
			(session_path, agent_id, process_identity, owner_session_id, owner_agent_id)
			SELECT session_path, ?, process_identity, owner_session_id, owner_agent_id
			FROM multi_agent_runtime_owners WHERE session_path = ? AND agent_id = ?`);
		const insertMessage =
			db.prepare(`INSERT INTO multi_agent_mailbox_messages (session_path, message_id, data, updated_at)
			VALUES (?, ?, json_set(?, '$.id', ?, '$.fromAgentId', ?, '$.threadId', ?), '2026-07-20T00:00:00.000Z')`);
		const seedAgent = (agentId: string, displayName: string) => {
			insertAgent.run(sessionPath, agentId, template.data, agentId, displayName);
			insertOwner.run(agentId, sessionPath, template.agent_id);
		};
		db.exec("BEGIN IMMEDIATE");
		for (let index = 0; index < counts.historyAgents; index++) seedAgent(`history_${index}`, `history-${index}`);
		for (let index = 1; index <= counts.pendingAgents; index++) {
			const agentId = `pending_${index}`;
			seedAgent(agentId, `pending-${index}`);
			insertMessage.run(
				sessionPath,
				`notice_${index}`,
				message.data,
				`notice_${index}`,
				agentId,
				`agent-completed:${agentId}`,
			);
		}
		db.exec("COMMIT");
	} finally {
		db.close();
	}
}

describe("agent notification waiting", () => {
	it("waits for terminal notifications without consuming them", async () => {
		const store = createStoreWithCompletedAgent();

		const wake = await waitNotifications(store);

		expect(wake).toMatchObject({ agent: { displayName: "Worker" }, kind: "agent" });
		expect(store.listMailboxMessages()).toMatchObject([{ status: "pending" }]);

		const consumed = consumeNotifications(store, wake);

		expect(consumed.content).toEqual([{ text: "Worker completed: done", type: "text" }]);
		expect(store.listMailboxMessages()).toEqual([]);
	});

	it("finds pending terminal notifications in a large terminal history without blocking", async () => {
		const { session, store } = createPersistedSession();
		completeAgent(store, "pending-0");
		seedCompletedHistory(session, { historyAgents: 7_000, pendingAgents: 140 });
		store.restoreFromSessionManager(session);

		const startedAt = performance.now();
		const wake = await waitNotifications(store);
		const elapsedMs = performance.now() - startedAt;
		const consumed = consumeNotifications(store, wake);

		expect(wake).toMatchObject({ agent: { displayName: "pending-0" }, kind: "agent" });
		expect(consumed.details?.agents?.map((agent) => agent.displayName)).toEqual(
			Array.from({ length: 141 }, (_, index) => `pending-${index}`),
		);
		expect(store.listMailboxMessages()).toEqual([]);
		expect(elapsedMs).toBeLessThan(1_000);
	});

	it("does not consume terminal notifications after a non-terminal wake", () => {
		const store = createStoreWithCompletedAgent();

		const result = consumeNotifications(store, { error: new Error("listener failed"), kind: "error" });

		expect(result.content).toEqual([{ text: "Wait failed: listener failed", type: "text" }]);
		expect(store.listMailboxMessages()).toMatchObject([{ status: "pending" }]);
	});

	it("reports a reconciliation failure on a poll tick as a wait error instead of throwing from the timer", async () => {
		const store = createPersistedStore();
		legacyMultiAgentStore(store).spawnAgent({
			agentType: "implement",
			cwd: "/repo",
			displayName: "Worker",
			permission: { narrowed: true, policy: "on-request" },
		});
		vi.spyOn(LifecycleCoordinator, "reconcileDeadDetachedRuntimes")
			.mockReturnValueOnce(0)
			.mockImplementation(() => {
				throw new Error("control db locked");
			});

		const wake = await waitNotifications(store);
		const result = consumeNotifications(store, wake);

		expect(result.content).toEqual([{ text: "Wait failed: control db locked", type: "text" }]);
	});

	it("preserves direct availability errors when waiting cannot start", async () => {
		const store = new MultiAgentStore();

		const wake = await waitNotifications(store);
		const result = consumeNotifications(store, wake);

		expect(result.content).toEqual([{ text: "wait_agent requires a persisted supervisor session.", type: "text" }]);
	});
});
