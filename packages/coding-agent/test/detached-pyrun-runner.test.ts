import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDetachedPyrunRunner, writeDetachedPyrunLaunchManifest } from "../extensions/pyrun/src/detached-runner.ts";
import { createDetachedJobLifecycleController } from "../src/core/detached-job-lifecycle.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { readMultiAgentState } from "../src/core/session-control-db.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("detached Pyrun runner", () => {
	it("owns evaluation output and commits one exact terminal envelope", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-pyrun-"));
		temporaryDirectories.push(root);
		const runnerPath = join(root, "fake-pyrun.mjs");
		writeFileSync(
			runnerPath,
			[
				"#!/usr/bin/env node",
				"import { createInterface } from 'node:readline';",
				"const lines = createInterface({ input: process.stdin });",
				"for await (const line of lines) {",
				"  const request = JSON.parse(line);",
				"  process.stdout.write(JSON.stringify({ type: 'progress', message: 'working' }) + '\\n');",
				"  process.stdout.write(JSON.stringify({ type: 'completed', executed: request.code, value: 42 }) + '\\n');",
				"}",
			].join("\n"),
		);
		chmodSync(runnerPath, 0o700);
		const controlDbPath = join(root, "control.sqlite");
		const sessionPath = join(root, "session.jsonl");
		const store = new MultiAgentStore();
		const coordinator = new LifecycleCoordinator({
			controlDbPath,
			createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
			createLeaseId: () => "lease-pyrun",
			now: () => new Date().toISOString(),
			reservationDurationMs: 60_000,
			runtimeIncarnation: "pyrun-runner",
			sessionPath,
		});
		const lifecycle = createDetachedJobLifecycleController({
			artifactRoot: root,
			controlDbPath,
			coordinator,
			ownerSessionId: "main",
			sessionPath,
			store,
		});
		const jobId = lifecycle.allocateJobId();
		const artifacts = lifecycle.createArtifacts(jobId);
		const reservation = lifecycle.reserve({
			agentType: "pyrun",
			cwd: root,
			displayName: "Pyrun evaluation",
			jobId,
			workerHandleId: "runner-test",
		});
		const manifestPath = join(artifacts.directory, "launch.json");
		writeDetachedPyrunLaunchManifest(manifestPath, {
			artifacts,
			controlDbPath,
			identity: reservation.identity,
			params: { code: "6 * 7" },
			runnerAddress: { agentId: jobId, sessionId: "main" },
			runnerOptions: { command: runnerPath, inheritEnv: true },
			sessionPath,
		});

		expect(await runDetachedPyrunRunner(manifestPath)).toEqual({ terminalRevision: 4 });
		const output = readFileSync(artifacts.outputPath, "utf8");
		expect(output).toContain('"kind":"progress"');
		expect(output).toContain('"value":42');
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: jobId, lifecycle: "completed", revision: 4 },
		]);
	});
});
