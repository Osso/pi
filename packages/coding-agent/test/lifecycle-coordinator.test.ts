import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import {
	readMultiAgentDispatchLease,
	readMultiAgentState,
	upsertMultiAgentAgent,
} from "../src/core/session-control-db.ts";

function createCoordinator(
	controlDbPath: string,
	sessionPath: string,
	now: () => string = () => "2026-07-11T20:00:00.000Z",
): LifecycleCoordinator {
	return new LifecycleCoordinator({
		controlDbPath,
		createAgentId: () => "agent-child",
		createLeaseId: () => "lease-child",
		now,
		reservationDurationMs: 30_000,
		runtimeIncarnation: "runtime-1",
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
	it("atomically creates a main-thread child with its first dispatch reservation", () => {
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
		expect(result.reservation).toMatchObject({
			agentId: "agent-child",
			fencingEpoch: 1,
			leaseId: "lease-child",
			owner: { agentId: null, sessionId: "supervisor-session" },
			runtimeIncarnation: "runtime-1",
		});
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toEqual([result.agent]);
		expect(readMultiAgentDispatchLease(controlDbPath, sessionPath, "agent-child")).toEqual(result.reservation);
	});

	it("fences runtime start and running confirmation with the committed reservation", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const starting = coordinator.beginChildRuntime({ agent: created.agent, reservation: created.reservation });
		expect(starting).toMatchObject({ ok: true, agent: { lifecycle: "starting", revision: 2 } });
		if (!starting.ok) return;
		const running = coordinator.confirmChildRuntime({ agent: starting.agent, reservation: created.reservation });
		expect(running).toMatchObject({ ok: true, agent: { lifecycle: "running", revision: 3 } });
	});

	it("requires cancelling before a fenced abort acknowledgement", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const starting = coordinator.beginChildRuntime({ agent: created.agent, reservation: created.reservation });
		expect(starting.ok).toBe(true);
		if (!starting.ok) return;
		const running = coordinator.confirmChildRuntime({ agent: starting.agent, reservation: created.reservation });
		expect(running.ok).toBe(true);
		if (!running.ok) return;

		const cancelling = coordinator.requestCancellation({ agent: running.agent, reservation: created.reservation });
		expect(cancelling).toMatchObject({ ok: true, agent: { lifecycle: "cancelling", revision: 4 } });
		if (!cancelling.ok) return;
		const aborted = coordinator.acknowledgeCancellation({
			agent: cancelling.agent,
			reason: "user requested",
			reservation: created.reservation,
		});
		expect(aborted).toMatchObject({ ok: true, agent: { lifecycle: "aborted", revision: 5 } });
		expect(
			coordinator.acknowledgeCancellation({
				agent: cancelling.agent,
				reason: "late duplicate",
				reservation: { ...created.reservation, fencingEpoch: created.reservation.fencingEpoch + 1 },
			}),
		).toEqual({ ok: false, error: "mutation_mismatch" });
	});

	it("orders natural completion before a later cancellation request", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const starting = coordinator.beginChildRuntime({ agent: created.agent, reservation: created.reservation });
		if (!starting.ok) return;
		const running = coordinator.confirmChildRuntime({ agent: starting.agent, reservation: created.reservation });
		if (!running.ok) return;
		const completed = coordinator.finalizeChild({
			agent: running.agent,
			eventPayload: { result: { summary: "done" } },
			reservation: created.reservation,
			result: { summary: "done" },
			terminalLifecycle: "completed",
		});
		expect(completed).toMatchObject({ ok: true, agent: { lifecycle: "completed", revision: 4 } });
		expect(coordinator.requestCancellation({ agent: running.agent, reservation: created.reservation })).toEqual({
			ok: false,
			error: "mutation_mismatch",
		});
	});

	it("orders accepted cancellation before natural completion and deduplicates exit acknowledgement", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		if (!created.ok) return;
		const starting = coordinator.beginChildRuntime({ agent: created.agent, reservation: created.reservation });
		if (!starting.ok) return;
		const running = coordinator.confirmChildRuntime({ agent: starting.agent, reservation: created.reservation });
		if (!running.ok) return;
		const cancelling = coordinator.requestCancellation({ agent: running.agent, reservation: created.reservation });
		if (!cancelling.ok) return;
		expect(
			coordinator.finalizeChild({
				agent: cancelling.agent,
				eventPayload: { result: { summary: "late" } },
				reservation: created.reservation,
				terminalLifecycle: "completed",
			}),
		).toEqual({ ok: false, error: "invalid_transition" });
		const acknowledgement = {
			agent: cancelling.agent,
			reason: "user requested",
			reservation: created.reservation,
		};
		const first = coordinator.acknowledgeCancellation(acknowledgement);
		expect(first).toMatchObject({ ok: true, agent: { lifecycle: "aborted", revision: 5 } });
		expect(coordinator.acknowledgeCancellation(acknowledgement)).toEqual(first);
	});

	it("rejects state mutation and finalization after lease expiry without takeover", () => {
		let nowIso = "2026-07-11T20:00:00.000Z";
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath, () => nowIso);
		const created = coordinator.createChild(childInput());
		if (!created.ok) return;
		nowIso = "2026-07-11T20:00:31.000Z";
		expect(coordinator.beginChildRuntime({ agent: created.agent, reservation: created.reservation })).toEqual({
			ok: false,
			error: "mutation_mismatch",
		});
		expect(
			coordinator.finalizeChild({
				agent: created.agent,
				eventPayload: { error: { code: "late" } },
				reservation: created.reservation,
				terminalLifecycle: "failed",
			}),
		).toEqual({ ok: false, error: "mutation_mismatch" });
	});

	it("terminalizes runtime construction failure from starting with one fenced event", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const starting = coordinator.beginChildRuntime({ agent: created.agent, reservation: created.reservation });
		expect(starting.ok).toBe(true);
		if (!starting.ok) return;

		const failed = coordinator.finalizeChild({
			agent: starting.agent,
			eventPayload: { error: { code: "runtime_spawn_failed", message: "factory failed" } },
			reservation: created.reservation,
			terminalLifecycle: "failed",
		});
		expect(failed).toMatchObject({ ok: true, agent: { lifecycle: "failed", revision: 3 } });
	});

	it("rejects runtime confirmation after the reservation fencing epoch changes", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const coordinator = createCoordinator(controlDbPath, sessionPath);
		const created = coordinator.createChild(childInput());
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const staleReservation = { ...created.reservation, fencingEpoch: created.reservation.fencingEpoch + 1 };
		expect(coordinator.beginChildRuntime({ agent: created.agent, reservation: staleReservation })).toEqual({
			ok: false,
			error: "mutation_mismatch",
		});
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: "agent-child", lifecycle: "queued", revision: 1 },
		]);
	});

	it("rejects a missing persisted agent parent without committing a child or reservation", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		const result = createCoordinator(controlDbPath, sessionPath).createChild(childInput("missing-parent"));

		expect(result).toEqual({ ok: false, error: "parent_not_found" });
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents ?? []).toEqual([]);
		expect(readMultiAgentDispatchLease(controlDbPath, sessionPath, "agent-child")).toBeUndefined();
	});

	it("links a nested child only after its parent exists", () => {
		const controlDbPath = join(mkdtempSync(join(tmpdir(), "pi-lifecycle-coordinator-")), "control.sqlite");
		const sessionPath = "/tmp/supervisor.jsonl";
		upsertMultiAgentAgent(controlDbPath, sessionPath, "agent-parent", {
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
