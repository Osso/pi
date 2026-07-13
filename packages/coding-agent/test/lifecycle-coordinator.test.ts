import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import {
	bootstrapMultiAgentAgent,
	listRuntimeMailboxMessages,
	readMultiAgentAgent,
	readMultiAgentRuntimeOwnership,
	readMultiAgentState,
	registerRuntimeMailboxListener,
} from "../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";
import { CURRENT_PROCESS_IDENTITY, testProcessIdentity } from "./helpers/process-identity.ts";
import { forceRuntimeOwnership } from "./helpers/runtime-ownership.ts";

function createCoordinator(
	controlDbPath: string,
	sessionPath: string,
	now: () => string = () => "2026-07-11T20:00:00.000Z",
	createAgentId: () => string = () => "agent-child",
): LifecycleCoordinator {
	registerRuntimeMailboxListener(
		controlDbPath,
		{ agentId: null, sessionId: "supervisor-session" },
		CURRENT_PROCESS_IDENTITY.pid,
		sessionPath,
		{ runtimeInstanceId: JSON.stringify(CURRENT_PROCESS_IDENTITY) },
	);
	return new LifecycleCoordinator({
		controlDbPath,
		createAgentId,
		now,
		processIdentity: CURRENT_PROCESS_IDENTITY,
		sessionPath,
	});
}

function childInput(parentId?: string) {
	return {
		agentType: "explore",
		cwd: "/tmp/worktree",
		displayName: "Explorer",
		parentId,
		permission: { narrowed: true, policy: "on-request" },
	};
}

function createRunningChild(
	coordinator: LifecycleCoordinator,
	input: ReturnType<typeof childInput> & { agentId?: string } = childInput(),
	processIdentity = CURRENT_PROCESS_IDENTITY,
) {
	const prepared = coordinator.prepareChild(input);
	return coordinator.commitRunningChild(prepared, "supervisor-session", processIdentity);
}

describe("LifecycleCoordinator child creation", () => {
	it("atomically creates a running child with runtime ownership", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const result = createRunningChild(createCoordinator(controlDbPath, sessionPath));

		expect(result).toMatchObject({
			agent: { id: "agent-child", lifecycle: "running", parentId: "main", revision: 1 },
			ok: true,
			ownership: {
				agentId: "agent-child",
				owner: { agentId: null, sessionId: "supervisor-session" },
				processIdentity: CURRENT_PROCESS_IDENTITY,
			},
		});
		if (!result.ok) return;
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toEqual([result.agent]);
		expect(readMultiAgentRuntimeOwnership(controlDbPath, sessionPath, "agent-child")).toEqual(result.ownership);
	});

	it("acquires attached runtime ownership while advancing the repository revision", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, "attached-1", {
			agentType: "resumed-session",
			createdAt: "2026-07-11T19:00:00.000Z",
			cwd: "/tmp/worktree",
			displayName: "Attached",
			id: "attached-1",
			lifecycle: "running",
			origin: "attached",
			permission: { narrowed: true, policy: "on-request" },
			revision: 4,
			updatedAt: "2026-07-11T19:00:00.000Z",
		});
		const agent = readMultiAgentAgent(controlDbPath, sessionPath, "attached-1");
		if (!agent) throw new Error("Expected attached test agent");
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const result = coordinator.acquireAttachedRuntime(agent, "supervisor-session");

		expect(result).toMatchObject({
			agent: { id: "attached-1", lifecycle: "running", revision: 5 },
			ok: true,
			ownership: { processIdentity: CURRENT_PROCESS_IDENTITY },
		});
		if (!result.ok) return;
		expect(coordinator.acquireAttachedRuntime(result.agent, "other-session")).toEqual({
			ok: false,
			error: "mutation_mismatch",
		});
	});

	it("rejects ownership takeover while the exact owner process is alive", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const created = createRunningChild(createCoordinator(controlDbPath, sessionPath));
		if (!created.ok) return;

		expect(
			forceRuntimeOwnership(controlDbPath, {
				agentId: created.agent.id,
				nowIso: "2026-07-11T20:01:00.000Z",
				owner: { agentId: null, sessionId: "supervisor-2" },
				processIdentity: testProcessIdentity("runtime-2"),
				sessionPath,
			}),
		).toMatchObject({ ok: false, error: "ownership_held" });
	});

	it("rejects another agent's ownership token even under the same supervisor process", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		let nextId = 0;
		const coordinator = createCoordinator(controlDbPath, sessionPath, undefined, () => `agent-${++nextId}`);
		const first = createRunningChild(coordinator);
		const second = createRunningChild(coordinator);
		if (!first.ok || !second.ok) throw new Error("Expected running child fixtures");

		expect(coordinator.requestCancellation({ agent: second.agent, ownership: first.ownership })).toEqual({
			ok: false,
			error: "mutation_mismatch",
		});
		expect(readMultiAgentAgent(controlDbPath, sessionPath, second.agent.id)).toMatchObject({
			lifecycle: "running",
			revision: 1,
		});
	});

	it("rejects lifecycle finalization from a different current process", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const ownerCoordinator = createCoordinator(controlDbPath, sessionPath);
		const created = createRunningChild(ownerCoordinator);
		if (!created.ok) throw new Error("Expected running child fixture");
		const foreignCoordinator = new LifecycleCoordinator({
			controlDbPath,
			createAgentId: () => "unused",
			now: () => "2026-07-11T20:00:01.000Z",
			processIdentity: testProcessIdentity("foreign-runtime"),
			sessionPath,
		});

		expect(
			foreignCoordinator.finalizeChild({
				agent: created.agent,
				ownership: created.ownership,
				terminalLifecycle: "completed",
			}),
		).toEqual({ ok: false, error: "mutation_mismatch" });
		expect(readMultiAgentAgent(controlDbPath, sessionPath, created.agent.id)).toMatchObject({
			lifecycle: "running",
			revision: 1,
		});
	});

	it("requires cancelling before abort acknowledgement", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const coordinator = createCoordinator(controlDbPath, "/tmp/supervisor.jsonl");
		const created = createRunningChild(coordinator);
		if (!created.ok) return;

		const cancelling = coordinator.requestCancellation(created);
		expect(cancelling).toMatchObject({ ok: true, agent: { lifecycle: "cancelling", revision: 2 } });
		if (!cancelling.ok) return;
		const aborted = coordinator.acknowledgeCancellation({
			agent: cancelling.agent,
			reason: "user requested",
			ownership: created.ownership,
		});
		expect(aborted).toMatchObject({ ok: true, agent: { lifecycle: "aborted", revision: 3 } });
		expect(
			coordinator.acknowledgeCancellation({
				agent: cancelling.agent,
				reason: "late duplicate",
				ownership: { ...created.ownership, processIdentity: testProcessIdentity("wrong-owner") },
			}),
		).toEqual({ ok: false, error: "mutation_mismatch" });
	});

	it("atomically requests detached cancellation and enqueues its runner command", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = createRunningChild(coordinator);
		if (!created.ok) return;

		const cancelling = coordinator.requestDetachedCancellation({
			agent: created.agent,
			outputLabel: "Bash output",
			reason: "user requested",
			ownership: created.ownership,
		});
		expect(cancelling).toMatchObject({ ok: true, agent: { lifecycle: "cancelling", revision: 2 } });
		const [message] = listRuntimeMailboxMessages(controlDbPath);
		expect(message).toMatchObject({
			kind: "system",
			recipient: { agentId: created.agent.id, sessionId: "supervisor-session" },
			status: "pending",
		});
		expect(JSON.parse(message?.body ?? "")).toMatchObject({
			command: "cancel",
			identity: {
				jobId: created.agent.id,
				outputLabel: "Bash output",
				owner: created.ownership.owner,
				processIdentity: created.ownership.processIdentity,
			},
		});
	});

	it("rolls back detached cancellation when canonical mailbox insertion fails", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = createRunningChild(coordinator);
		if (!created.ok) return;
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`CREATE TRIGGER reject_detached_control BEFORE INSERT ON multi_agent_mailbox_messages
				WHEN NEW.message_id LIKE 'detached-cancel:%'
				BEGIN SELECT RAISE(ABORT, 'blocked detached control'); END`);
		} finally {
			db.close();
		}

		expect(() =>
			coordinator.requestDetachedCancellation({
				agent: created.agent,
				outputLabel: "Bash output",
				ownership: created.ownership,
			}),
		).toThrow("blocked detached control");
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: created.agent.id, lifecycle: "running", revision: 1 },
		]);
		expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
	});

	it("blocks dead-owner parent recovery until active descendants are terminal", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		let nextId = 0;
		const coordinator = createCoordinator(controlDbPath, sessionPath, undefined, () => `agent-${++nextId}`);
		const deadIdentity = testProcessIdentity("dead-parent-runtime");
		const parent = createRunningChild(coordinator, childInput(), deadIdentity);
		if (!parent.ok) throw new Error("Expected parent fixture");
		const child = createRunningChild(coordinator, childInput(parent.agent.id), deadIdentity);
		if (!child.ok) throw new Error("Expected child fixture");

		expect(
			coordinator.recoverDeadChild({
				agent: parent.agent,
				ownerSessionId: "supervisor-session",
				ownership: parent.ownership,
			}),
		).toEqual({ ok: false, error: "invalid_transition" });
		expect(readMultiAgentAgent(controlDbPath, sessionPath, parent.agent.id)).toMatchObject({
			lifecycle: "running",
			revision: 1,
		});
	});

	it("blocks parent terminalization until active descendants are terminal", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		let nextId = 0;
		const coordinator = createCoordinator(controlDbPath, sessionPath, undefined, () => `agent-${++nextId}`);
		const parent = createRunningChild(coordinator);
		if (!parent.ok) return;
		const child = createRunningChild(coordinator, childInput(parent.agent.id));
		if (!child.ok) return;

		expect(
			coordinator.finalizeChild({
				agent: parent.agent,
				ownership: parent.ownership,
				terminalLifecycle: "completed",
			}),
		).toEqual({ ok: false, error: "invalid_transition" });
		expect(
			coordinator.finalizeChild({
				agent: child.agent,
				ownership: child.ownership,
				terminalLifecycle: "completed",
			}).ok,
		).toBe(true);
		expect(
			coordinator.finalizeChild({
				agent: parent.agent,
				ownership: parent.ownership,
				terminalLifecycle: "completed",
			}).ok,
		).toBe(true);
	});

	it("orders natural completion before a later cancellation request", () => {
		const coordinator = createCoordinator(
			join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite"),
			"/tmp/supervisor.jsonl",
		);
		const created = createRunningChild(coordinator);
		if (!created.ok) return;
		const completed = coordinator.finalizeChild({
			agent: created.agent,
			ownership: created.ownership,
			result: { summary: "done" },
			terminalLifecycle: "completed",
		});
		expect(completed).toMatchObject({ ok: true, agent: { lifecycle: "completed", revision: 2 } });
		expect(coordinator.requestCancellation(created)).toEqual({ ok: false, error: "invalid_transition" });
	});

	it("orders accepted cancellation before natural completion and deduplicates acknowledgement", () => {
		const coordinator = createCoordinator(
			join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite"),
			"/tmp/supervisor.jsonl",
		);
		const created = createRunningChild(coordinator);
		if (!created.ok) return;
		const cancelling = coordinator.requestCancellation(created);
		if (!cancelling.ok) return;
		expect(
			coordinator.finalizeChild({
				agent: cancelling.agent,
				ownership: created.ownership,
				terminalLifecycle: "completed",
			}),
		).toEqual({ ok: false, error: "invalid_transition" });
		const acknowledgement = { agent: cancelling.agent, reason: "user requested", ownership: created.ownership };
		const first = coordinator.acknowledgeCancellation(acknowledgement);
		expect(first).toMatchObject({ ok: true, agent: { lifecycle: "aborted", revision: 3 } });
		expect(coordinator.acknowledgeCancellation(acknowledgement)).toEqual(first);
	});

	it("does not persist a child until construction succeeds", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const prepared = coordinator.prepareChild(childInput());

		expect(prepared).toMatchObject({ id: "agent-child", lifecycle: "running", revision: 1 });
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents ?? []).toEqual([]);
		expect(coordinator.commitRunningChild(prepared, "supervisor-session")).toMatchObject({
			ok: true,
			agent: { id: "agent-child", lifecycle: "running", revision: 1 },
		});
	});

	it("persists interrupted construction directly as failed without ownership", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const failed = coordinator.commitFailedChild(coordinator.prepareChild(childInput()), {
			code: "runtime_spawn_failed",
			message: "factory interrupted",
		});

		expect(failed).toMatchObject({
			ok: true,
			agent: {
				error: { code: "runtime_spawn_failed", message: "factory interrupted" },
				id: "agent-child",
				lifecycle: "failed",
				revision: 1,
			},
		});
		expect(readMultiAgentRuntimeOwnership(controlDbPath, sessionPath, "agent-child")).toBeUndefined();
	});

	it("uses a preallocated artifact identity without consuming another ID", () => {
		let generatedIds = 0;
		const coordinator = createCoordinator(
			join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite"),
			"/tmp/supervisor.jsonl",
			undefined,
			() => `generated-${++generatedIds}`,
		);

		const prepared = coordinator.prepareChild({ ...childInput(), agentId: "preallocated-job" });
		expect(coordinator.commitRunningChild(prepared, "supervisor-session")).toMatchObject({
			ok: true,
			agent: { id: "preallocated-job" },
		});
		expect(generatedIds).toBe(0);
	});

	it("rejects child and attachment creation beneath a terminal parent", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		let nextId = 0;
		const coordinator = createCoordinator(controlDbPath, sessionPath, undefined, () => `agent-${++nextId}`);
		const parent = createRunningChild(coordinator);
		if (!parent.ok) throw new Error("Expected parent fixture");
		const completed = coordinator.finalizeChild({
			agent: parent.agent,
			ownership: parent.ownership,
			terminalLifecycle: "completed",
		});
		expect(completed).toMatchObject({ ok: true });

		expect(createRunningChild(coordinator, childInput(parent.agent.id))).toEqual({
			ok: false,
			error: "parent_not_found",
		});
		expect(
			coordinator.createAttachment({
				agentType: "attached",
				cwd: "/tmp/worktree",
				displayName: "Attached",
				parentId: parent.agent.id,
				permission: { narrowed: true, policy: "on-request" },
			}),
		).toEqual({ ok: false, error: "parent_not_found" });
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toHaveLength(1);
	});

	it("rejects a missing parent without committing child or ownership", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const prepared = coordinator.prepareChild(childInput("missing-parent"));
		const result = coordinator.commitRunningChild(prepared, "supervisor-session");

		expect(result).toEqual({ ok: false, error: "parent_not_found" });
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents ?? []).toEqual([]);
		expect(readMultiAgentRuntimeOwnership(controlDbPath, sessionPath, "agent-child")).toBeUndefined();
	});
});
