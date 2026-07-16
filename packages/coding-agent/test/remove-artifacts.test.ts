import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAgentsCoreTools, registerAgentsMailboxTools } from "../extensions/agents-core/src/runtime.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import {
	allocateMultiAgentCounter,
	bootstrapMultiAgentAgent,
	getControlDbPath,
	readMultiAgentState,
	upsertMultiAgentMailboxMessage,
} from "../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";
import { legacyMultiAgentStore } from "./helpers/legacy-multi-agent-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

type RegisteredTool = Pick<ToolDefinition, "name" | "parameters">;

function createStore(): MultiAgentStore {
	return new MultiAgentStore({ now: () => "2026-07-11T00:00:00.000Z" });
}

function spawnAgent(store: MultiAgentStore) {
	return legacyMultiAgentStore(store).spawnAgent({
		agentType: "worker",
		cwd: "/repo",
		displayName: "Worker",
		permission: { narrowed: true, policy: "on-request" },
	});
}

describe("artifact removal", () => {
	it("rejects relative file references at mailbox ingress", () => {
		const store = createStore();
		const agent = spawnAgent(store);

		expect(() =>
			store.contactParent(agent.agent.id, {
				body: "See the log",
				fileRefs: [{ path: "relative/output.log" }],
			} as never),
		).toThrow(/absolute/i);
	});

	it("rejects non-string file reference labels at store ingress", () => {
		const store = createStore();
		const agent = spawnAgent(store);

		expect(() =>
			store.contactParent(agent.agent.id, {
				body: "See the log",
				fileRefs: [{ path: "/tmp/output.log", label: 42 }],
			} as never),
		).toThrow(/label.*string/i);
	});

	it("carries absolute file references on completion notifications", () => {
		const store = createStore();
		const agent = spawnAgent(store);
		const completed = legacyMultiAgentStore(store).transitionAgent(
			agent.agent.id,
			agent.agent.revision,
			"completed",
			{
				result: { summary: "done", fileRefs: [{ path: "/tmp/output.log", label: "Output" }] } as never,
			},
		);
		expect(completed.ok).toBe(true);
		if (!completed.ok) throw new Error("expected completion transition");
		const [notification] = store.listPendingLifecycleNotificationsForAgent(agent.agent.id, "completed");
		expect(notification.fileRefs).toEqual([{ path: "/tmp/output.log", label: "Output" }]);
		expect(notification).not.toHaveProperty("artifactIds");
		expect(completed.agent.result).not.toHaveProperty("artifactIds");
	});

	it("rejects non-string file reference labels at DB ingress", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-remove-artifacts-label-db-"));
		tempDirs.push(tempDir);
		const controlDbPath = getControlDbPath(tempDir);

		expect(() =>
			bootstrapMultiAgentAgent(controlDbPath, "/sessions/invalid-agent.jsonl", "agent-1", {
				result: { fileRefs: [{ path: "/tmp/output.log", label: 42 }] },
			}),
		).toThrow(/label.*string/i);
	});

	it("rejects incomplete persisted agent and mailbox payloads", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-remove-artifacts-invalid-state-"));
		tempDirs.push(tempDir);
		const controlDbPath = getControlDbPath(tempDir);
		const sessionPath = "/sessions/invalid-state.jsonl";

		expect(() => bootstrapMultiAgentAgent(controlDbPath, sessionPath, "agent_1", {})).toThrow(/persisted agent/i);
		expect(() => upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, "message_1", {})).toThrow(
			/persisted mailbox/i,
		);
	});

	it("rejects removed artifact fields at fresh DB ingress", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-remove-artifacts-fresh-db-"));
		tempDirs.push(tempDir);
		const controlDbPath = getControlDbPath(tempDir);
		const sessionPath = "/sessions/fresh-invalid.jsonl";

		expect(() =>
			bootstrapMultiAgentAgent(controlDbPath, sessionPath, "agent-1", {
				result: { artifactIds: ["artifact-1"] },
			} as never),
		).toThrow(/Legacy artifact fields/);
		expect(() =>
			upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, "message-1", {
				artifactRefs: [{ path: "/tmp/legacy.log" }],
			} as never),
		).toThrow(/Legacy artifact fields/);
	});

	it("merges legacy counters by maximum and drops removed artifact storage", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-remove-artifacts-migration-"));
		tempDirs.push(tempDir);
		const controlDbPath = getControlDbPath(tempDir);
		readMultiAgentState(controlDbPath, "/sessions/bootstrap.jsonl");
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`
				CREATE TABLE multi_agent_counters (
					session_path TEXT PRIMARY KEY,
					next_agent_number INTEGER NOT NULL,
					next_message_number INTEGER NOT NULL,
					next_artifact_number INTEGER NOT NULL,
					updated_at TEXT NOT NULL
				);
				CREATE TABLE multi_agent_artifacts (
					session_path TEXT NOT NULL,
					artifact_id TEXT NOT NULL,
					data TEXT NOT NULL,
					updated_at TEXT NOT NULL
				);
			`);
			db.prepare("INSERT INTO multi_agent_counters VALUES (?, ?, ?, ?, ?)").run(
				"/sessions/main.jsonl",
				10,
				12,
				99,
				"2026-07-11T00:00:00.000Z",
			);
			db.prepare("INSERT INTO multi_agent_counters_v2 VALUES (?, ?, ?, ?)").run(
				"/sessions/main.jsonl",
				2,
				3,
				"2026-07-10T00:00:00.000Z",
			);
		} finally {
			db.close();
		}

		expect(allocateMultiAgentCounter(controlDbPath, "/sessions/main.jsonl", "agent")).toBe(10);
		const migrated = createSqliteDatabase(controlDbPath);
		try {
			const tables = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
				name: string;
			}>;
			expect(tables.map((table) => table.name)).not.toContain("multi_agent_counters");
			expect(tables.map((table) => table.name)).not.toContain("multi_agent_artifacts");
		} finally {
			migrated.close();
		}
	});

	it("does not initialize artifact tables or legacy counter columns", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-remove-artifacts-db-"));
		tempDirs.push(tempDir);
		const controlDbPath = getControlDbPath(tempDir);
		readMultiAgentState(controlDbPath, "/sessions/main.jsonl");
		const db = createSqliteDatabase(controlDbPath);
		try {
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'multi_agent_%'")
				.all() as Array<{ name: string }>;
			expect(tables.map((table) => table.name)).not.toContain("multi_agent_artifacts");
			expect(tables.map((table) => table.name)).toContain("multi_agent_counters_v2");
			const counterColumns = db.prepare("PRAGMA table_info(multi_agent_counters_v2)").all() as Array<{
				name: string;
			}>;
			expect(counterColumns.map((column) => column.name)).not.toContain("next_artifact_number");
		} finally {
			db.close();
		}
	});

	it("does not register the removed artifact tool and exposes fileRefs on mailbox tools", () => {
		const tools = new Map<string, RegisteredTool>();
		const pi = {
			registerCommand() {},
			registerTool(tool: ToolDefinition) {
				tools.set(tool.name, { name: tool.name, parameters: tool.parameters });
			},
		} as unknown as ExtensionAPI;

		const store = createStore();
		registerAgentsCoreTools(pi, { store });
		registerAgentsMailboxTools(pi, { store });

		expect(tools.has("agent_artifacts")).toBe(false);
		expect(tools.get("send_agent_message")?.parameters).toMatchObject({
			properties: expect.objectContaining({ fileRefs: expect.anything() }),
		});
	});
});
