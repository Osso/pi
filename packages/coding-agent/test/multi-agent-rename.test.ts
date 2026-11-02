import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectAgentRows } from "../extensions/agents-status/src/index.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { getControlDbPath, updateMultiAgentAgentActivity } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { legacyMultiAgentStore } from "./helpers/legacy-multi-agent-store.ts";

describe("persisted agent renaming", () => {
	it("renames active and terminal agents without changing lifecycle metadata", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-agent-rename-"));
		try {
			const session = SessionManager.create("/repo", dir);
			session.setMetadataControlDbPath(getControlDbPath(dir));
			let now = "2026-01-01T00:00:00.000Z";
			const store = MultiAgentStore.fromSessionManager(session, { now: () => now });
			const spawn = () =>
				legacyMultiAgentStore(store).spawnAgent({
					agentType: "scout",
					cwd: "/repo",
					displayName: "Scout",
					model: { providerId: "provider", modelId: "model" },
					parentId: "main",
					permission: { narrowed: true, policy: "on-request" },
					transcript: { sessionId: "child", path: "/tmp/child.jsonl" },
				}).agent;
			const active = spawn();
			const terminal = spawn();
			const completion = legacyMultiAgentStore(store).transitionAgent(terminal.id, terminal.revision, "completed");
			if (!completion.ok) throw new Error("expected completion");
			const updates = vi.fn();
			const transitions = vi.fn();
			const notifications = vi.fn();
			store.subscribeAgentUpdates(updates);
			store.subscribeAgentTransitions(transitions);
			store.subscribeLifecycleNotifications(notifications);

			for (const invalid of ["", "   ", "bad\nname", "bad\tname", "bad\u007fname", "bad\u2028name"]) {
				expect(() => store.renameAgent(active.id, invalid)).toThrow(/display name/i);
			}
			expect(store.renameAgent("missing", "Name")).toEqual({ ok: false, error: "not_found", agentId: "missing" });
			expect(updates).not.toHaveBeenCalled();
			expect(store.getAgent(active.id)).toEqual(active);

			const target = store.getPersistenceTarget();
			if (!target) throw new Error("expected persisted store");
			const progress = updateMultiAgentAgentActivity(
				target.controlDbPath,
				target.sessionPath,
				active.id,
				{ description: "Progress" },
				new Date(Date.parse(completion.agent.updatedAt) + 3000).toISOString(),
			);
			if (!progress) throw new Error("expected persisted progress");
			now = new Date(Date.parse(completion.agent.updatedAt) + 20_000).toISOString();
			expect(collectAgentRows([completion.agent], Date.parse(now))).toEqual([]);
			const renamedActive = store.renameAgent(active.id, "  Shared name  ");
			const renamedTerminal = store.renameAgent(terminal.id, "Shared name");
			expect(renamedActive).toEqual({
				ok: true,
				agent: { ...progress, displayName: "Shared name" },
			});
			expect(renamedTerminal).toEqual({
				ok: true,
				agent: { ...completion.agent, displayName: "Shared name" },
			});
			if (!renamedTerminal.ok) throw new Error("expected rename");
			expect(collectAgentRows([renamedTerminal.agent], Date.parse(now))).toEqual([]);
			expect(Date.parse(renamedTerminal.agent.updatedAt) - Date.parse(renamedTerminal.agent.createdAt)).toBe(
				Date.parse(completion.agent.updatedAt) - Date.parse(completion.agent.createdAt),
			);
			expect(updates).toHaveBeenCalledTimes(2);
			expect(updates.mock.calls[0][0]).toEqual(active);
			expect(updates.mock.calls[0][1].displayName).toBe("Shared name");
			expect(transitions).not.toHaveBeenCalled();
			expect(notifications).not.toHaveBeenCalled();
			expect(store.getProjectionSnapshot().rows.map((row) => row.displayName)).toEqual([
				"Shared name",
				"Shared name",
			]);
			const reloaded = MultiAgentStore.fromSessionManager(session);
			expect(reloaded.getAgent(active.id)).toEqual(store.getAgent(active.id));
			expect(reloaded.getAgent(terminal.id)).toEqual(store.getAgent(terminal.id));
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});
});
