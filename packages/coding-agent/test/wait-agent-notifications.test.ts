import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consumeNotifications, waitNotifications } from "../extensions/agents-core/src/index.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { getControlDbPath } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { legacyMultiAgentStore } from "./helpers/legacy-multi-agent-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { force: true, recursive: true });
});

function createPersistedStore(): MultiAgentStore {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-wait-notifications-"));
	tempDirs.push(tempDir);
	const session = SessionManager.create("/repo", join(tempDir, "sessions"));
	session.setMetadataControlDbPath(getControlDbPath(tempDir));
	const store = new MultiAgentStore({ now: () => "2026-07-20T00:00:00.000Z" });
	store.setPersistenceSessionManager(session);
	return store;
}

function createStoreWithCompletedAgent(): MultiAgentStore {
	const store = createPersistedStore();
	const spawned = legacyMultiAgentStore(store).spawnAgent({
		agentType: "implement",
		cwd: "/repo",
		displayName: "Worker",
		permission: { narrowed: true, policy: "on-request" },
	});
	const completed = legacyMultiAgentStore(store).transitionAgent(
		spawned.agent.id,
		spawned.agent.revision,
		"completed",
		{ result: { summary: "done" } },
	);
	if (!completed.ok) throw new Error("expected completed agent fixture");
	return store;
}

describe("agent notification waiting", () => {
	it("waits for terminal notifications without consuming them", async () => {
		const store = createStoreWithCompletedAgent();

		const wake = await waitNotifications(store);

		expect(wake).toMatchObject({ agent: { displayName: "Worker" }, kind: "agent" });
		expect(store.listMailboxMessages()).toMatchObject([{ status: "pending" }]);

		const consumed = consumeNotifications(store, wake);

		expect(consumed.content).toEqual([{ text: "Worker completed: done", type: "text" }]);
		expect(store.listMailboxMessages()).toMatchObject([{ status: "delivered" }]);
	});

	it("does not consume terminal notifications after a non-terminal wake", () => {
		const store = createStoreWithCompletedAgent();

		const result = consumeNotifications(store, { error: new Error("listener failed"), kind: "error" });

		expect(result.content).toEqual([{ text: "Wait failed: listener failed", type: "text" }]);
		expect(store.listMailboxMessages()).toMatchObject([{ status: "pending" }]);
	});
});
