import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDetachedBashRunner, writeDetachedBashLaunchManifest } from "../src/core/detached-bash-runner.ts";
import { createDetachedJobLifecycleController } from "../src/core/detached-job-lifecycle.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import {
	enqueueRuntimeMailboxMessage,
	readMultiAgentAgent,
	upsertMultiAgentMailboxMessage,
} from "../src/core/session-control-db.ts";
import { testProcessIdentity } from "./helpers/process-identity.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("detached Bash runner cancellation", () => {
	it("adopts the cancelling revision, terminates the payload group, and finalizes aborted", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-detached-bash-cancel-"));
		temporaryDirectories.push(root);
		const controlDbPath = join(root, "control.sqlite");
		const sessionPath = join(root, "session.jsonl");
		const runnerAddress = { agentId: "agent_1", sessionId: "supervisor-1" };
		const store = new MultiAgentStore();
		const coordinator = new LifecycleCoordinator({
			controlDbPath,
			createAgentId: () => runnerAddress.agentId,
			now: () => new Date().toISOString(),
			processIdentity: testProcessIdentity("runner-1"),
			sessionPath,
		});
		const lifecycle = createDetachedJobLifecycleController({
			artifactRoot: root,
			controlDbPath,
			coordinator,
			ownerSessionId: runnerAddress.sessionId,
			sessionPath,
			store,
		});
		const artifacts = lifecycle.createArtifacts(runnerAddress.agentId);
		const ownership = lifecycle.register({
			agentType: "bash",
			cwd: root,
			displayName: "Bash command",
			jobId: runnerAddress.agentId,
			processIdentity: testProcessIdentity("runner"),
			workerHandleId: "runner-pending",
		});
		const manifestPath = join(artifacts.directory, "launch.json");
		writeDetachedBashLaunchManifest(manifestPath, {
			args: ["-e", "setInterval(() => console.log('running'), 50)"],
			artifacts,
			command: process.execPath,
			controlDbPath,
			cwd: root,
			env: process.env,
			identity: ownership.identity,
			runnerAddress,
			sessionPath,
		});
		const running = runDetachedBashRunner(manifestPath);
		await waitFor(() => existsSync(join(artifacts.directory, "payload.json")));
		const cancelling = coordinator.requestCancellation({
			agent: ownership.agent,
			ownership: ownership.controlOwnership,
		});
		expect(cancelling.ok).toBe(true);
		if (!cancelling.ok) return;
		upsertMultiAgentMailboxMessage(controlDbPath, sessionPath, "message_1", {
			body: JSON.stringify({ command: "cancel", identity: ownership.identity, reason: "test cancel" }),
			fromAgentId: "main",
			id: "message_1",
			kind: "system",
			status: "pending",
			toAgentId: runnerAddress.agentId,
		});
		enqueueRuntimeMailboxMessage(controlDbPath, {
			kind: "system",
			recipient: runnerAddress,
			sender: { agentId: null, sessionId: runnerAddress.sessionId },
			storeRef: { messageId: "message_1", sessionPath },
		});

		expect(await running).toMatchObject({ terminalRevision: cancelling.agent.revision + 1 });
		expect(readMultiAgentAgent(controlDbPath, sessionPath, runnerAddress.agentId)).toMatchObject({
			lifecycle: "aborted",
			revision: cancelling.agent.revision + 1,
		});
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for detached payload");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
