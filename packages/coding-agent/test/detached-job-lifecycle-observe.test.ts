import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDetachedJobLifecycleController } from "../src/core/detached-job-lifecycle.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { registerRuntimeMailboxListener } from "../src/core/session-control-db.ts";
import { CURRENT_PROCESS_IDENTITY, testProcessIdentity } from "./helpers/process-identity.ts";

function createFixture(ownerSessionId = "supervisor-1") {
	const root = mkdtempSync(join(tmpdir(), "pi-detached-observe-"));
	const controlDbPath = join(root, "control.sqlite");
	const sessionPath = join(root, "session.jsonl");
	const fixture = createController({ controlDbPath, ownerSessionId, root, sessionPath });
	return { ...fixture, controlDbPath, root, sessionPath };
}

function createController(input: { controlDbPath: string; ownerSessionId: string; root: string; sessionPath: string }) {
	registerRuntimeMailboxListener(
		input.controlDbPath,
		{ agentId: null, sessionId: input.ownerSessionId },
		CURRENT_PROCESS_IDENTITY.pid,
		input.sessionPath,
		{ runtimeInstanceId: JSON.stringify(CURRENT_PROCESS_IDENTITY) },
	);
	const store = new MultiAgentStore();
	const coordinator = new LifecycleCoordinator({
		controlDbPath: input.controlDbPath,
		createAgentId: () => "unused",
		now: () => "2026-07-12T00:00:00.000Z",
		processIdentity: CURRENT_PROCESS_IDENTITY,
		sessionPath: input.sessionPath,
	});
	const controller = createDetachedJobLifecycleController({
		artifactRoot: input.root,
		controlDbPath: input.controlDbPath,
		coordinator,
		ownerSessionId: input.ownerSessionId,
		sessionPath: input.sessionPath,
		store,
	});
	return { controller, store };
}

describe("detached job lifecycle observation", () => {
	it("recovers an active job when its persisted runner identity is no longer alive", () => {
		const fixture = createFixture();
		const ownership = fixture.controller.register({
			agentType: "bash",
			cwd: "/repo",
			displayName: "Bash command",
			jobId: fixture.controller.allocateJobId("bash"),
			processIdentity: { ...CURRENT_PROCESS_IDENTITY, startTimeTicks: CURRENT_PROCESS_IDENTITY.startTimeTicks + 1 },
			workerHandleId: "runner-1",
		});

		expect(fixture.controller.observe(ownership.agent.id)).toMatchObject({
			error: { code: "lost_runtime" },
			id: ownership.agent.id,
			lifecycle: "failed",
			revision: 2,
		});
		expect(fixture.store.getAgent(ownership.agent.id)).toMatchObject({
			error: { code: "lost_runtime" },
			lifecycle: "failed",
			revision: 2,
		});
	});

	it("keeps an active job running when its exact persisted runner identity is alive", () => {
		const fixture = createFixture();
		const ownership = fixture.controller.register({
			agentType: "bash",
			cwd: "/repo",
			displayName: "Bash command",
			jobId: fixture.controller.allocateJobId("bash"),
			processIdentity: CURRENT_PROCESS_IDENTITY,
			workerHandleId: "runner-1",
		});

		expect(fixture.controller.observe(ownership.agent.id)).toMatchObject({
			id: ownership.agent.id,
			lifecycle: "running",
			revision: 1,
		});
		expect(fixture.store.getAgent(ownership.agent.id)).toMatchObject({ lifecycle: "running", revision: 1 });
	});

	it("does not recover a dead runner owned by another session", () => {
		const fixture = createFixture("other-session");
		const ownership = fixture.controller.register({
			agentType: "bash",
			cwd: "/repo",
			displayName: "Bash command",
			jobId: fixture.controller.allocateJobId("bash"),
			processIdentity: testProcessIdentity("runner-dead-other-session"),
			workerHandleId: "runner-1",
		});
		const observer = createController({
			controlDbPath: fixture.controlDbPath,
			ownerSessionId: "supervisor-1",
			root: fixture.root,
			sessionPath: fixture.sessionPath,
		});

		expect(observer.controller.observe(ownership.agent.id)).toMatchObject({
			id: ownership.agent.id,
			lifecycle: "running",
			revision: 1,
		});
	});
});
