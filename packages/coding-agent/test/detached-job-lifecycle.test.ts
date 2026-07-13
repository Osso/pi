import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createDetachedJobLifecycleController,
	type DetachedJobLifecycleControllerOptions,
} from "../src/core/detached-job-lifecycle.ts";
import { createDetachedJobTerminalInput } from "../src/core/detached-job-runner.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { finalizeDetachedJob, readMultiAgentState } from "../src/core/session-control-db.ts";
import { testProcessIdentity } from "./helpers/process-identity.ts";

function createFixture(
	options: Pick<DetachedJobLifecycleControllerOptions, "writeBashLaunchManifest"> & {
		ownerSessionId?: string;
		root?: string;
		sessionName?: string;
	} = {},
) {
	const root = options.root ?? mkdtempSync(join(tmpdir(), "pi-detached-lifecycle-"));
	const controlDbPath = join(root, "control.sqlite");
	const sessionPath = join(root, options.sessionName ?? "session.jsonl");
	const store = new MultiAgentStore();
	const coordinator = new LifecycleCoordinator({
		controlDbPath,
		createAgentId: () => "unused",
		now: () => "2026-07-11T22:00:00.000Z",
		processIdentity: testProcessIdentity("runtime-1"),
		sessionPath,
	});
	const controller = createDetachedJobLifecycleController({
		artifactRoot: root,
		controlDbPath,
		coordinator,
		ownerSessionId: options.ownerSessionId ?? "supervisor-1",
		sessionPath,
		store,
		writeBashLaunchManifest: options.writeBashLaunchManifest,
	});
	return { controlDbPath, controller, sessionPath, store };
}

describe("detached job lifecycle controller", () => {
	it("isolates reused agent IDs by supervisor session", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-lifecycle-shared-"));
		const first = createFixture({ ownerSessionId: "supervisor-1", root, sessionName: "session-1.jsonl" });
		const second = createFixture({ ownerSessionId: "supervisor-2", root, sessionName: "session-2.jsonl" });

		const firstArtifacts = first.controller.createArtifacts("agent_1");
		const secondArtifacts = second.controller.createArtifacts("agent_1");

		expect(firstArtifacts.directory).not.toBe(secondArtifacts.directory);
		expect(firstArtifacts.directory).toContain("session-1");
		expect(secondArtifacts.directory).toContain("session-2");
	});

	it("rejects an existing detached job directory before runner launch", () => {
		const fixture = createFixture();
		fixture.controller.createArtifacts("agent_1");

		expect(() => fixture.controller.createArtifacts("agent_1")).toThrow(/already exists/i);
	});

	it("kills and fails a Bash runner when launch manifest persistence fails", () => {
		const fixture = createFixture({
			writeBashLaunchManifest: () => {
				throw new Error("manifest disk failure");
			},
		});

		expect(() =>
			fixture.controller.launchBash({
				args: ["-e", "setInterval(() => {}, 1000)"],
				command: process.execPath,
				cwd: "/repo",
				env: process.env,
			}),
		).toThrow("manifest disk failure");
		expect(fixture.store.listAgents()).toMatchObject([
			{ error: { code: "runtime_spawn_failed" }, lifecycle: "failed", revision: 2 },
		]);
	});

	it("binds preallocated artifacts, ownership, projection, and exact finalization", () => {
		const fixture = createFixture();
		const jobId = fixture.controller.allocateJobId("bash");
		const artifacts = fixture.controller.createArtifacts(jobId);
		const ownership = fixture.controller.register({
			agentType: "bash",
			cwd: "/repo",
			displayName: "Bash command",
			jobId,
			processIdentity: testProcessIdentity("runner"),
			workerHandleId: "123",
		});
		expect(ownership).toMatchObject({
			agent: { id: jobId, lifecycle: "running", revision: 1 },
			artifacts,
		});
		expect(fixture.store.getAgent(jobId)).toMatchObject({ lifecycle: "running" });

		writeFileSync(artifacts.outputPath, "done", { mode: 0o600 });
		const terminal = createDetachedJobTerminalInput(
			artifacts,
			ownership.identity,
			{ exitCode: 0, kind: "completed", summary: "done" },
			"2026-07-11T22:00:30.000Z",
		);
		expect(finalizeDetachedJob(fixture.controlDbPath, { sessionPath: fixture.sessionPath, terminal })).toMatchObject({
			ok: true,
			terminalAgent: { id: jobId, lifecycle: "completed", revision: 2 },
			terminalRevision: 2,
		});
		expect(readMultiAgentState(fixture.controlDbPath, fixture.sessionPath)?.agents).toMatchObject([
			{ id: jobId, lifecycle: "completed", revision: 2 },
		]);
	});

	it("requests detached cancellation through the coordinator and publishes cancelling state", () => {
		const fixture = createFixture();
		const jobId = fixture.controller.allocateJobId("bash");
		const ownership = fixture.controller.register({
			agentType: "bash",
			cwd: "/repo",
			displayName: "Bash command",
			jobId,
			processIdentity: testProcessIdentity("runner"),
			workerHandleId: "runner-1",
		});

		expect(fixture.controller.cancel(ownership, "user requested")).toMatchObject({
			agent: { id: jobId, lifecycle: "cancelling", revision: 2 },
			ok: true,
		});
		expect(fixture.store.getAgent(jobId)).toMatchObject({ lifecycle: "cancelling", revision: 2 });
	});

	it("observes and publishes a terminal snapshot committed by an external runner", () => {
		const fixture = createFixture();
		const jobId = fixture.controller.allocateJobId("bash");
		const artifacts = fixture.controller.createArtifacts(jobId);
		const ownership = fixture.controller.register({
			agentType: "bash",
			cwd: "/repo",
			displayName: "Bash command",
			jobId,
			processIdentity: testProcessIdentity("runner"),
			workerHandleId: "runner-1",
		});
		writeFileSync(artifacts.outputPath, "done", { mode: 0o600 });
		const terminal = createDetachedJobTerminalInput(
			artifacts,
			ownership.identity,
			{ exitCode: 0, kind: "completed" },
			"2026-07-11T22:00:30.000Z",
		);
		expect(finalizeDetachedJob(fixture.controlDbPath, { sessionPath: fixture.sessionPath, terminal })).toMatchObject({
			ok: true,
			terminalRevision: 2,
		});
		expect(fixture.store.getAgent(jobId)).toMatchObject({ lifecycle: "running", revision: 1 });

		expect(fixture.controller.observe(jobId)).toMatchObject({ id: jobId, lifecycle: "completed", revision: 2 });
		expect(fixture.store.getAgent(jobId)).toMatchObject({ lifecycle: "completed", revision: 2 });
	});
});
