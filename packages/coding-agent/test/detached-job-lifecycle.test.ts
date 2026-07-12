import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDetachedJobLifecycleController } from "../src/core/detached-job-lifecycle.ts";
import { writeDetachedJobTerminalEnvelope } from "../src/core/detached-job-runner.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { readMultiAgentState } from "../src/core/session-control-db.ts";

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-detached-lifecycle-"));
	const controlDbPath = join(root, "control.sqlite");
	const sessionPath = join(root, "session.jsonl");
	const store = new MultiAgentStore();
	const coordinator = new LifecycleCoordinator({
		controlDbPath,
		createAgentId: () => "unused",
		createLeaseId: () => "lease-1",
		now: () => "2026-07-11T22:00:00.000Z",
		reservationDurationMs: 60_000,
		runtimeIncarnation: "runtime-1",
		sessionPath,
	});
	const controller = createDetachedJobLifecycleController({
		artifactRoot: root,
		controlDbPath,
		coordinator,
		ownerSessionId: "supervisor-1",
		sessionPath,
		store,
	});
	return { controlDbPath, controller, sessionPath, store };
}

describe("detached job lifecycle controller", () => {
	it("binds preallocated artifacts, reservation, projection, and exact finalization", () => {
		const fixture = createFixture();
		const jobId = fixture.controller.allocateJobId();
		const artifacts = fixture.controller.createArtifacts(jobId);
		const reservation = fixture.controller.reserve({
			agentType: "bash",
			cwd: "/repo",
			displayName: "Bash command",
			jobId,
			workerHandleId: "123",
		});
		expect(reservation).toMatchObject({
			agent: { id: jobId, lifecycle: "running", revision: 3 },
			artifacts,
			identity: { expectedRevision: 3, jobId, leaseId: "lease-1", runtimeIncarnation: "runtime-1" },
		});
		expect(fixture.store.getAgent(jobId)).toMatchObject({ lifecycle: "running" });

		writeFileSync(artifacts.outputPath, "done", { mode: 0o600 });
		writeDetachedJobTerminalEnvelope(
			artifacts,
			reservation.identity,
			{ exitCode: 0, kind: "completed", summary: "done" },
			"2026-07-11T22:00:30.000Z",
		);
		expect(fixture.controller.finalize(artifacts.terminalEnvelopePath)).toEqual({ ok: true, terminalRevision: 4 });
		expect(readMultiAgentState(fixture.controlDbPath, fixture.sessionPath)?.agents).toMatchObject([
			{ id: jobId, lifecycle: "completed", revision: 4 },
		]);
	});
});
