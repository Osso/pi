import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	finalizeDetachedJobWithRetry,
	runDetachedBashRunner,
	writeDetachedBashLaunchManifest,
} from "../src/core/detached-bash-runner.ts";
import { createDetachedJobLifecycleController } from "../src/core/detached-job-lifecycle.ts";
import { createDetachedJobTerminalInput } from "../src/core/detached-job-runner.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { readMultiAgentState } from "../src/core/session-control-db.ts";
import { testProcessIdentity } from "./helpers/process-identity.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("detached Bash runner", () => {
	it("owns payload exit and commits one exact terminal input", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-bash-runner-"));
		temporaryDirectories.push(root);
		const controlDbPath = join(root, "control.sqlite");
		const sessionPath = join(root, "session.jsonl");
		const store = new MultiAgentStore();
		const coordinator = new LifecycleCoordinator({
			controlDbPath,
			createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
			now: () => "2026-07-11T22:00:00.000Z",
			processIdentity: testProcessIdentity("runner-1"),
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
		const ownership = lifecycle.register({
			agentType: "bash",
			cwd: root,
			displayName: "Bash command",
			jobId,
			processIdentity: testProcessIdentity("runner"),
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
			env: process.env,
			identity: ownership.identity,
			runnerAddress: { agentId: jobId, sessionId: "main" },
			sessionPath,
		});

		expect(await runDetachedBashRunner(manifestPath, { now: () => "2026-07-11T22:00:30.000Z" })).toEqual({
			exitCode: 0,
			terminalRevision: 2,
		});
		expect(readFileSync(markerPath, "utf8")).toBe("ran");
		expect(readFileSync(artifacts.outputPath, "utf8")).toContain("done");
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{ id: jobId, lifecycle: "completed", revision: 2 },
		]);
		expect(readMultiAgentState(controlDbPath, sessionPath)?.agents).toMatchObject([
			{
				id: jobId,
				result: { fileRefs: [{ path: artifacts.outputPath }], summary: "Process exited successfully." },
			},
		]);
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
			now: () => new Date().toISOString(),
			processIdentity: testProcessIdentity("runner-process"),
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
		const launched = lifecycle.launchBash({
			args: ["-e", 'setTimeout(() => console.log("independent"), 300)'],
			command: process.execPath,
			cwd: root,
			env: process.env,
		});
		const { artifacts } = launched.ownership;
		const runnerPid = launched.runnerPid;
		expect(existsSync(`${launched.manifestPath}.runner-error`)).toBe(false);
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

	it("does not retry non-database terminal finalization failures", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-bash-non-db-failure-"));
		temporaryDirectories.push(root);
		const outputPath = join(root, "output.log");
		writeFileSync(outputPath, "done", { mode: 0o600 });
		const terminal = createDetachedJobTerminalInput(
			{ directory: root, outputPath },
			{
				jobId: "job-1",
				owner: { agentId: null, sessionId: "runner" },
				outputLabel: "Bash output",
				processIdentity: testProcessIdentity("retry"),
			},
			{ kind: "completed", summary: "done" },
			"2026-07-11T22:00:00.000Z",
		);
		let attempts = 0;

		await expect(
			Promise.race([
				finalizeDetachedJobWithRetry(
					terminal,
					() => {
						attempts += 1;
						throw new Error("invalid terminal payload");
					},
					{ retryDelayMs: 1 },
				),
				new Promise((_, reject) => setTimeout(() => reject(new Error("finalizer kept retrying")), 20)),
			]),
		).rejects.toThrow("invalid terminal payload");
		expect(attempts).toBe(1);
	});

	it("retries the same terminal input after transient database failures", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-bash-retry-"));
		temporaryDirectories.push(root);
		const outputPath = join(root, "output.log");
		writeFileSync(outputPath, "done", { mode: 0o600 });
		const terminal = createDetachedJobTerminalInput(
			{ directory: root, outputPath },
			{
				jobId: "job-1",
				owner: { agentId: null, sessionId: "runner" },
				outputLabel: "Bash output",
				processIdentity: testProcessIdentity("retry"),
			},
			{ kind: "completed", summary: "done" },
			"2026-07-11T22:00:00.000Z",
		);
		const transientErrors = [
			Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY", errno: 5 }),
			Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
		];
		for (const transientError of transientErrors) {
			const attempts: (typeof terminal)[] = [];
			const result = await finalizeDetachedJobWithRetry(
				terminal,
				(terminalInput) => {
					attempts.push(terminalInput);
					if (attempts.length < 3) throw transientError;
					return { ok: true, terminalRevision: 8 };
				},
				{ retryDelayMs: 0, sleep: async () => undefined },
			);

			expect(result).toEqual({ ok: true, terminalRevision: 8 });
			expect(attempts).toEqual([terminal, terminal, terminal]);
		}
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for detached Bash runner state");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
