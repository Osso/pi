import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDetachedJobLifecycleController } from "../src/core/detached-job-lifecycle.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { registerRuntimeMailboxListener } from "../src/core/session-control-db.ts";
import { CURRENT_PROCESS_IDENTITY, testProcessIdentity } from "./helpers/process-identity.ts";

const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createFixture(ownerSessionId = "supervisor-1") {
	const root = mkdtempSync(join(tmpdir(), "pi-detached-observe-"));
	fixtureRoots.push(root);
	const controlDbPath = join(root, "control.sqlite");
	const sessionPath = join(root, "session.jsonl");
	const fixture = createController({ controlDbPath, ownerSessionId, root, sessionPath });
	return { ...fixture, controlDbPath, root, sessionPath };
}

function createController(input: {
	controlDbPath: string;
	ownerAgentId?: string;
	ownerSessionId: string;
	root: string;
	sessionPath: string;
}) {
	registerRuntimeMailboxListener(
		input.controlDbPath,
		{ agentId: input.ownerAgentId ?? null, sessionId: input.ownerSessionId },
		CURRENT_PROCESS_IDENTITY.pid,
		input.ownerAgentId ? undefined : input.sessionPath,
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
		ownerAgentId: input.ownerAgentId,
		ownerSessionId: input.ownerSessionId,
		sessionPath: input.sessionPath,
		store,
	});
	return { controller, coordinator, store };
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

	it("recovers a dead runner owned by a live subagent runtime", () => {
		const fixture = createFixture();
		const ownerAgentId = "agent_1";
		const ownerSessionId = "child-session-1";
		const parent = fixture.coordinator.prepareChild({
			agentId: ownerAgentId,
			agentType: "explore",
			cwd: "/repo",
			displayName: "Parent agent",
			permission: { narrowed: true, policy: "on-request" },
			transcript: { path: join(fixture.root, "child.jsonl"), sessionId: ownerSessionId },
		});
		expect(fixture.coordinator.commitRunningChild(parent, "supervisor-1")).toMatchObject({ ok: true });
		const subagent = createController({
			controlDbPath: fixture.controlDbPath,
			ownerAgentId,
			ownerSessionId,
			root: fixture.root,
			sessionPath: fixture.sessionPath,
		});
		const ownership = subagent.controller.register({
			agentType: "bash",
			cwd: "/repo",
			displayName: "Bash command",
			jobId: subagent.controller.allocateJobId("bash"),
			processIdentity: testProcessIdentity("dead-subagent-runner"),
			workerHandleId: "runner-1",
		});

		expect(subagent.controller.observe(ownership.agent.id)).toMatchObject({
			error: { code: "lost_runtime" },
			id: ownership.agent.id,
			lifecycle: "failed",
			revision: 2,
		});
	});

	it("does not recover a subagent job through a different child runtime", () => {
		const fixture = createFixture();
		for (const [agentId, sessionId] of [
			["agent_owner", "child-owner"],
			["agent_other", "child-other"],
		] as const) {
			const parent = fixture.coordinator.prepareChild({
				agentId,
				agentType: "explore",
				cwd: "/repo",
				displayName: agentId,
				permission: { narrowed: true, policy: "on-request" },
				transcript: { path: join(fixture.root, `${agentId}.jsonl`), sessionId },
			});
			expect(fixture.coordinator.commitRunningChild(parent, "supervisor-1")).toMatchObject({ ok: true });
		}
		const owner = createController({
			controlDbPath: fixture.controlDbPath,
			ownerAgentId: "agent_owner",
			ownerSessionId: "child-owner",
			root: fixture.root,
			sessionPath: fixture.sessionPath,
		});
		const ownership = owner.controller.register({
			agentType: "bash",
			cwd: "/repo",
			displayName: "Bash command",
			jobId: owner.controller.allocateJobId("bash"),
			processIdentity: testProcessIdentity("dead-owned-runner"),
			workerHandleId: "runner-1",
		});
		const other = createController({
			controlDbPath: fixture.controlDbPath,
			ownerAgentId: "agent_other",
			ownerSessionId: "child-other",
			root: fixture.root,
			sessionPath: fixture.sessionPath,
		});

		expect(other.controller.observe(ownership.agent.id)).toMatchObject({
			id: ownership.agent.id,
			lifecycle: "running",
			revision: 1,
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
