import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatAgentLifecycleTrace, readAgentLifecycleTrace } from "../src/core/agent-lifecycle-trace.ts";
import type { AgentSnapshot } from "../src/core/multi-agent-store.ts";
import { withControlDb } from "../src/core/session-control-db.ts";

describe("agent-lifecycle-trace", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns undefined processIdentity instead of throwing when persisted runtime ownership JSON is malformed", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-trace-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "control.sqlite");
		const sessionPath = join(dir, "session.jsonl");
		const agent: AgentSnapshot = {
			id: "agent-1",
			parentId: undefined,
			displayName: "worker",
			agentType: "implement",
			lifecycle: "running",
			revision: 1,
			createdAt: "2026-11-12T00:00:00.000Z",
			updatedAt: "2026-11-12T00:00:01.000Z",
			cwd: dir,
			permission: { policy: "default", narrowed: false },
		};

		withControlDb(dbPath, (db) => {
			db.prepare(
				`INSERT INTO multi_agent_runtime_owners (
					session_path, agent_id, process_identity, owner_session_id, owner_agent_id
				) VALUES (?, ?, ?, ?, ?)`,
			).run(sessionPath, agent.id, "{corrupt-json", "sess-1", null);
		});

		const trace = readAgentLifecycleTrace({
			agent,
			agents: [agent],
			controlDbPath: dbPath,
			sessionPath,
		});

		expect(trace.ownership).toEqual({
			agentId: "agent-1",
			owner: { agentId: null, sessionId: "sess-1" },
			processIdentity: undefined,
			sessionPath,
		});
		expect(formatAgentLifecycleTrace(trace)).toContain("runtime_ownership owner=sess-1:main process=unbound");
	});
});
