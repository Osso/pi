import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentLifecycleState, AgentSnapshot } from "../src/core/multi-agent-store.ts";
import { getControlDbPath, readMultiAgentState } from "../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

const HOUR_MS = 60 * 60 * 1000;
const sessionPath = "/sessions/terminal-expiry.jsonl";
const tempDirs: string[] = [];

afterEach(() => {
	for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { force: true, recursive: true });
});

function createControlDb(): string {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-terminal-expiry-"));
	tempDirs.push(tempDir);
	return getControlDbPath(tempDir);
}

function agent(
	id: string,
	lifecycle: AgentLifecycleState,
	ageHours: number,
	extra: Partial<AgentSnapshot> = {},
): AgentSnapshot {
	const timestamp = new Date(Date.now() - ageHours * HOUR_MS).toISOString();
	return {
		agentType: "implement",
		createdAt: timestamp,
		cwd: "/repo",
		displayName: id,
		id,
		lifecycle,
		parentId: undefined,
		permission: { narrowed: true, policy: "on-request" },
		revision: 2,
		updatedAt: timestamp,
		...extra,
	};
}

// Raw inserts bypass control-DB opens, so retention cleanup sees the complete fixture at once.
function seedRows(controlDbPath: string, agents: AgentSnapshot[], undeliveredOutboxAgentId: string): void {
	readMultiAgentState(controlDbPath, sessionPath);
	const db = createSqliteDatabase(controlDbPath);
	try {
		const now = new Date().toISOString();
		const insertAgent = db.prepare(
			"INSERT INTO multi_agent_agents (session_path, agent_id, data, updated_at) VALUES (?, ?, ?, ?)",
		);
		db.exec("BEGIN IMMEDIATE");
		for (const snapshot of agents) insertAgent.run(sessionPath, snapshot.id, JSON.stringify(snapshot), now);
		db.prepare(
			`INSERT INTO multi_agent_terminal_outbox
			(session_path, agent_id, terminal_revision, event_kind, status, attempt_count, updated_at)
			VALUES (?, ?, 2, 'completed', 'pending', 0, ?)`,
		).run(sessionPath, undeliveredOutboxAgentId, now);
		db.exec("COMMIT");
	} finally {
		db.close();
	}
}

function persistedAgentIds(controlDbPath: string): string[] {
	const agents = (readMultiAgentState(controlDbPath, sessionPath)?.agents ?? []) as AgentSnapshot[];
	return agents.map((persisted) => persisted.id).sort();
}

describe("terminal agent row expiry", () => {
	it("expires terminal agents 24h after their terminal update and keeps rows still needed", () => {
		const controlDbPath = createControlDb();
		const jobOutput = { fileRefs: [{ label: "Bash output", path: "/agent/detached-jobs/s/job/output.log" }] };
		const seeded = [
			agent("expired_completed", "completed", 25),
			agent("expired_failed", "failed", 25),
			agent("expired_aborted", "aborted", 25),
			agent("recent_completed", "completed", 23),
			agent("old_running", "running", 25),
			agent("old_job_output", "completed", 25, { result: { summary: "done", ...jobOutput } }),
			agent("old_undelivered_outbox", "completed", 25),
			agent("old_parent_of_active", "completed", 25),
			agent("active_child", "running", 1, { parentId: "old_parent_of_active" }),
			agent("old_parent_of_terminal", "completed", 25),
			agent("expired_child", "completed", 25, { parentId: "old_parent_of_terminal" }),
		];
		seedRows(controlDbPath, seeded, "old_undelivered_outbox");

		expect(persistedAgentIds(controlDbPath)).toEqual([
			"active_child",
			"old_job_output",
			"old_parent_of_active",
			"old_running",
			"old_undelivered_outbox",
			"recent_completed",
		]);
	});
});
