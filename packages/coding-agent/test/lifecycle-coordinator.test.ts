import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import {
	acquireMultiAgentRuntimeOwnership,
	bootstrapMultiAgentAgent,
	listRuntimeMailboxMessages,
	readMultiAgentAgent,
	readMultiAgentRuntimeOwnership,
	readMultiAgentState,
} from "../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";
import { CURRENT_PROCESS_IDENTITY, testProcessIdentity } from "./helpers/process-identity.ts";

function createCoordinator(
	controlDbPath: string,
	sessionPath: string,
	now: () => string = () => "2026-07-11T20:00:00.000Z",
	createAgentId: () => string = () => "agent-child",
): LifecycleCoordinator {
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
		ownerSessionId: "supervisor-session",
		parentId,
		permission: { narrowed: true, policy: "on-request" },
	};
}

describe("LifecycleCoordinator child creation", () => {
	it("atomically creates a main-thread child with its first runtime ownership", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const result = createCoordinator(controlDbPath, sessionPath).createChild(childInput());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.agent).toMatchObject({
			id: "agent-child",
			lifecycle: "queued",
			parentId: "main",
			revision: 1,
		});
		expect(result.ownership).toMatchObject({
			agentId: "agent-child",
			owner: { agentId: null, sessionId: "supervisor-session" },
			processIdentity: CURRENT_PROCESS_IDENTITY,
		});
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
		const result = createCoordinator(controlDbPath, sessionPath).acquireAttachedRuntime(agent, "supervisor-session");

		expect(result).toMatchObject({
			agent: { id: "attached-1", lifecycle: "running", revision: 5 },
			ok: true,
			ownership: { processIdentity: CURRENT_PROCESS_IDENTITY },
		});
		if (!result.ok) return;
		expect(
			createCoordinator(controlDbPath, sessionPath).acquireAttachedRuntime(result.agent, "other-session"),
		).toEqual({
			ok: false,
			error: "ownership_held",
		});
	});

	it("validates runtime start and running confirmation with committed process ownership", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const starting = coordinator.beginChildRuntime({ agent: created.agent, ownership: created.ownership });
		expect(starting).toMatchObject({ ok: true, agent: { lifecycle: "starting", revision: 2 } });
		if (!starting.ok) return;
		const running = coordinator.confirmChildRuntime({ agent: starting.agent, ownership: created.ownership });
		expect(running).toMatchObject({ ok: true, agent: { lifecycle: "running", revision: 3 } });
	});

	it("rejects ownership takeover while the exact owner process is alive", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		expect(
			acquireMultiAgentRuntimeOwnership(controlDbPath, {
				agentId: created.agent.id,
				nowIso: "2026-07-11T20:01:00.000Z",
				owner: { agentId: null, sessionId: "supervisor-2" },
				processIdentity: testProcessIdentity("runtime-2"),
				sessionPath,
			}),
		).toMatchObject({ ok: false, error: "ownership_held" });
	});

	it("requires cancelling before a fenced abort acknowledgement", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const starting = coordinator.beginChildRuntime({ agent: created.agent, ownership: created.ownership });
		expect(starting.ok).toBe(true);
		if (!starting.ok) return;
		const running = coordinator.confirmChildRuntime({ agent: starting.agent, ownership: created.ownership });
		expect(running.ok).toBe(true);
		if (!running.ok) return;

		const cancelling = coordinator.requestCancellation({ agent: running.agent, ownership: created.ownership });
		expect(cancelling).toMatchObject({ ok: true, agent: { lifecycle: "cancelling", revision: 4 } });
		if (!cancelling.ok) return;
		const aborted = coordinator.acknowledgeCancellation({
			agent: cancelling.agent,
			reason: "user requested",
			ownership: created.ownership,
		});
		expect(aborted).toMatchObject({ ok: true, agent: { lifecycle: "aborted", revision: 5 } });
		expect(
			coordinator.acknowledgeCancellation({
				agent: cancelling.agent,
				reason: "late duplicate",
				ownership: { ...created.ownership, processIdentity: testProcessIdentity("wrong-owner") },
			}),
		).toEqual({ ok: false, error: "mutation_mismatch" });
	});

	it("atomically requests detached cancellation and enqueues its fenced runner command", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		if (!created.ok) return;
		const starting = coordinator.beginChildRuntime({ agent: created.agent, ownership: created.ownership });
		if (!starting.ok) return;
		const running = coordinator.confirmChildRuntime({ agent: starting.agent, ownership: created.ownership });
		if (!running.ok) return;

		const cancelling = coordinator.requestDetachedCancellation({
			agent: running.agent,
			outputLabel: "Bash output",
			reason: "user requested",
			ownership: created.ownership,
		});
		expect(cancelling).toMatchObject({ ok: true, agent: { lifecycle: "cancelling", revision: 4 } });
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: running.agent.id, lifecycle: "cancelling", revision: 4 },
		]);
		const [message] = listRuntimeMailboxMessages(controlDbPath);
		expect(message).toMatchObject({
			kind: "system",
			recipient: { agentId: running.agent.id, sessionId: "supervisor-session" },
			status: "pending",
		});
		expect(JSON.parse(message?.body ?? "")).toMatchObject({
			command: "cancel",
			identity: {
				jobId: running.agent.id,
				outputLabel: "Bash output",
				owner: created.ownership.owner,
				processIdentity: created.ownership.processIdentity,
			},
			reason: "user requested",
		});
	});

	it("rolls back detached cancellation when runtime-mailbox transport insertion fails", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		if (!created.ok) return;
		const starting = coordinator.beginChildRuntime({ agent: created.agent, ownership: created.ownership });
		if (!starting.ok) return;
		const running = coordinator.confirmChildRuntime({ agent: starting.agent, ownership: created.ownership });
		if (!running.ok) return;
		const db = createSqliteDatabase(controlDbPath);
		try {
			db.exec(`CREATE TRIGGER reject_detached_control BEFORE INSERT ON runtime_mailbox_messages
				BEGIN SELECT RAISE(ABORT, 'blocked detached control'); END`);
		} finally {
			db.close();
		}

		expect(() =>
			coordinator.requestDetachedCancellation({
				agent: running.agent,
				outputLabel: "Bash output",
				ownership: created.ownership,
			}),
		).toThrow("blocked detached control");
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: running.agent.id, lifecycle: "running", revision: 3 },
		]);
		expect(listRuntimeMailboxMessages(controlDbPath)).toEqual([]);
	});

	it("blocks parent terminalization until active descendants are terminal", () => {
		const ids = ["agent-parent", "agent-child"];
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath, undefined, () => ids.shift() ?? "agent-extra");
		const parent = coordinator.createChild(childInput());
		if (!parent.ok) return;
		const parentStarting = coordinator.beginChildRuntime({ agent: parent.agent, ownership: parent.ownership });
		if (!parentStarting.ok) return;
		const parentRunning = coordinator.confirmChildRuntime({
			agent: parentStarting.agent,
			ownership: parent.ownership,
		});
		if (!parentRunning.ok) return;
		const child = coordinator.createChild(childInput(parent.agent.id));
		if (!child.ok) return;
		const childStarting = coordinator.beginChildRuntime({ agent: child.agent, ownership: child.ownership });
		if (!childStarting.ok) return;
		const childRunning = coordinator.confirmChildRuntime({
			agent: childStarting.agent,
			ownership: child.ownership,
		});
		if (!childRunning.ok) return;

		expect(
			coordinator.finalizeChild({
				agent: parentRunning.agent,
				eventPayload: { result: { summary: "parent" } },
				ownership: parent.ownership,
				terminalLifecycle: "completed",
			}),
		).toEqual({ ok: false, error: "invalid_transition" });
		expect(
			coordinator.finalizeChild({
				agent: childRunning.agent,
				eventPayload: { result: { summary: "child" } },
				ownership: child.ownership,
				terminalLifecycle: "completed",
			}).ok,
		).toBe(true);
		expect(
			coordinator.finalizeChild({
				agent: parentRunning.agent,
				eventPayload: { result: { summary: "parent" } },
				ownership: parent.ownership,
				terminalLifecycle: "completed",
			}).ok,
		).toBe(true);
	});

	it("orders natural completion before a later cancellation request", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const starting = coordinator.beginChildRuntime({ agent: created.agent, ownership: created.ownership });
		if (!starting.ok) return;
		const running = coordinator.confirmChildRuntime({ agent: starting.agent, ownership: created.ownership });
		if (!running.ok) return;
		const completed = coordinator.finalizeChild({
			agent: running.agent,
			eventPayload: { result: { summary: "done" } },
			ownership: created.ownership,
			result: { summary: "done" },
			terminalLifecycle: "completed",
		});
		expect(completed).toMatchObject({ ok: true, agent: { lifecycle: "completed", revision: 4 } });
		expect(coordinator.requestCancellation({ agent: running.agent, ownership: created.ownership })).toEqual({
			ok: false,
			error: "invalid_transition",
		});
	});

	it("orders accepted cancellation before natural completion and deduplicates exit acknowledgement", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		if (!created.ok) return;
		const starting = coordinator.beginChildRuntime({ agent: created.agent, ownership: created.ownership });
		if (!starting.ok) return;
		const running = coordinator.confirmChildRuntime({ agent: starting.agent, ownership: created.ownership });
		if (!running.ok) return;
		const cancelling = coordinator.requestCancellation({ agent: running.agent, ownership: created.ownership });
		if (!cancelling.ok) return;
		expect(
			coordinator.finalizeChild({
				agent: cancelling.agent,
				eventPayload: { result: { summary: "late" } },
				ownership: created.ownership,
				terminalLifecycle: "completed",
			}),
		).toEqual({ ok: false, error: "invalid_transition" });
		const acknowledgement = {
			agent: cancelling.agent,
			reason: "user requested",
			ownership: created.ownership,
		};
		const first = coordinator.acknowledgeCancellation(acknowledgement);
		expect(first).toMatchObject({ ok: true, agent: { lifecycle: "aborted", revision: 5 } });
		expect(coordinator.acknowledgeCancellation(acknowledgement)).toEqual(first);
	});

	it("terminalizes runtime construction failure from starting with one fenced event", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const starting = coordinator.beginChildRuntime({ agent: created.agent, ownership: created.ownership });
		expect(starting.ok).toBe(true);
		if (!starting.ok) return;

		const failed = coordinator.finalizeChild({
			agent: starting.agent,
			eventPayload: { error: { code: "runtime_spawn_failed", message: "factory failed" } },
			ownership: created.ownership,
			terminalLifecycle: "failed",
		});
		expect(failed).toMatchObject({ ok: true, agent: { lifecycle: "failed", revision: 3 } });
	});

	it("rejects runtime confirmation from a different owner process", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const staleOwnership = { ...created.ownership, processIdentity: testProcessIdentity("stale-owner") };
		expect(coordinator.beginChildRuntime({ agent: created.agent, ownership: staleOwnership })).toEqual({
			ok: false,
			error: "mutation_mismatch",
		});
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: "agent-child", lifecycle: "queued", revision: 1 },
		]);
	});

	it("creates a child with a preallocated artifact identity without consuming another ID", () => {
		let generatedIds = 0;
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = new LifecycleCoordinator({
			controlDbPath,
			createAgentId: () => {
				generatedIds += 1;
				return `generated-${generatedIds}`;
			},
			now: () => "2026-07-11T20:00:00.000Z",
			processIdentity: CURRENT_PROCESS_IDENTITY,
			sessionPath,
		});

		const created = coordinator.createChild({ ...childInput(), agentId: "preallocated-job" });
		expect(created).toMatchObject({ ok: true, agent: { id: "preallocated-job" } });
		expect(generatedIds).toBe(0);
		expect(coordinator.createChild({ ...childInput(), agentId: "preallocated-job" })).toEqual({
			ok: false,
			error: "agent_exists",
		});
	});

	it("rejects a missing persisted agent parent without committing a child or ownership", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const result = createCoordinator(controlDbPath, sessionPath).createChild(childInput("missing-parent"));

		expect(result).toEqual({ ok: false, error: "parent_not_found" });
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents ?? []).toEqual([]);
		expect(readMultiAgentRuntimeOwnership(controlDbPath, sessionPath, "agent-child")).toBeUndefined();
	});

	it("links a nested child only after its parent exists", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		bootstrapMultiAgentAgent(controlDbPath, sessionPath, "agent-parent", {
			agentType: "explore",
			createdAt: "2026-07-11T19:00:00.000Z",
			cwd: "/tmp/worktree",
			displayName: "Parent",
			id: "agent-parent",
			lifecycle: "running",
			parentId: "main",
			permission: { narrowed: true, policy: "on-request" },
			revision: 2,
			updatedAt: "2026-07-11T19:00:01.000Z",
		});

		const result = createCoordinator(controlDbPath, sessionPath).createChild(childInput("agent-parent"));

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.agent.parentId).toBe("agent-parent");
	});
});
