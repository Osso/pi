import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	finalizeDetachedEnvelopeWithRetry,
	launchDetachedBashRunner,
	runDetachedBashRunner,
	writeDetachedBashLaunchManifest,
} from "../src/core/detached-bash-runner.ts";
import { createDetachedJobLifecycleController } from "../src/core/detached-job-lifecycle.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { readMultiAgentState } from "../src/core/session-control-db.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("detached Bash runner", () => {
	it("owns payload exit and commits one exact terminal envelope", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-bash-runner-"));
		temporaryDirectories.push(root);
		const controlDbPath = join(root, "control.sqlite");
		const sessionPath = join(root, "session.jsonl");
		const store = new MultiAgentStore();
		const coordinator = new LifecycleCoordinator({
			controlDbPath,
			createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
			createLeaseId: () => "lease-1",
			now: () => "2026-07-11T22:00:00.000Z",
			reservationDurationMs: 60_000,
			runtimeIncarnation: "runner-1",
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
			agentType: "bash",
			cwd: root,
			displayName: "Bash command",
			jobId,
			workerHandleId: "runner-pending",
		});
		const markerPath = join(root, "payload-ran");
		const manifestPath = join(artifacts.directory, "launch.json");
		writeDetachedBashLaunchManifest(manifestPath, {
			args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran"); console.log("done")`],
			artifacts,
			command: process.execPath,
			controlDbPath,
			cwd: root,
			identity: reservation.identity,
			runnerAddress: { agentId: jobId, sessionId: "main" },
			sessionPath,
		});

		expect(await runDetachedBashRunner(manifestPath, { now: () => "2026-07-11T22:00:30.000Z" })).toEqual({
			exitCode: 0,
			terminalRevision: 4,
		});
		expect(readFileSync(markerPath, "utf8")).toBe("ran");
		expect(readFileSync(artifacts.outputPath, "utf8")).toContain("done");
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: jobId, lifecycle: "completed", revision: 4 },
		]);
		const envelope = JSON.parse(readFileSync(artifacts.terminalEnvelopePath, "utf8"));
		expect(envelope).toMatchObject({ jobId, outcome: { exitCode: 0, kind: "completed" } });
	});

	it("launches an independent runner that remains the payload parent", async () => {
		if (process.platform !== "linux") return;
		const root = mkdtempSync(join(tmpdir(), "pi-detached-bash-process-"));
		temporaryDirectories.push(root);
		const controlDbPath = join(root, "control.sqlite");
		const sessionPath = join(root, "session.jsonl");
		const store = new MultiAgentStore();
		const coordinator = new LifecycleCoordinator({
			controlDbPath,
			createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
			createLeaseId: () => "lease-process",
			now: () => new Date().toISOString(),
			reservationDurationMs: 60_000,
			runtimeIncarnation: "runner-process",
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
			agentType: "bash",
			cwd: root,
			displayName: "Bash command",
			jobId,
			workerHandleId: "runner-pending",
		});
		const manifestPath = join(artifacts.directory, "launch.json");
		writeDetachedBashLaunchManifest(manifestPath, {
			args: ["-e", 'setTimeout(() => console.log("independent"), 300)'],
			artifacts,
			command: process.execPath,
			controlDbPath,
			cwd: root,
			identity: reservation.identity,
			runnerAddress: { agentId: jobId, sessionId: "main" },
			sessionPath,
		});

		const runnerPid = launchDetachedBashRunner(manifestPath, {
			entryPath: join(import.meta.dirname, "../src/core/detached-bash-runner-entry.ts"),
		});
		const identityPath = join(artifacts.directory, "payload.json");
		await waitFor(() => existsSync(identityPath));
		const payloadIdentity = JSON.parse(readFileSync(identityPath, "utf8"));
		expect(readFileSync(`/proc/${payloadIdentity.pid}/status`, "utf8")).toContain(`PPid:\t${runnerPid}`);
		await waitFor(() => {
			const agent = readMultiAgentState(controlDbPath, sessionPath)?.agents[0];
			return typeof agent === "object" && agent !== null && "lifecycle" in agent && agent.lifecycle === "completed";
		});
		expect(readFileSync(artifacts.outputPath, "utf8")).toContain("independent");
	});

	it("retries the same terminal envelope after transient database failures", async () => {
		const attempts: string[] = [];
		const result = await finalizeDetachedEnvelopeWithRetry(
			"/jobs/job-1/terminal.json",
			(envelopePath) => {
				attempts.push(envelopePath);
				if (attempts.length < 3) throw new Error("database unavailable");
				return { ok: true, terminalRevision: 8 };
			},
			{ retryDelayMs: 0, sleep: async () => undefined },
		);

		expect(result).toEqual({ ok: true, terminalRevision: 8 });
		expect(attempts).toEqual(["/jobs/job-1/terminal.json", "/jobs/job-1/terminal.json", "/jobs/job-1/terminal.json"]);
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for detached Bash runner state");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
