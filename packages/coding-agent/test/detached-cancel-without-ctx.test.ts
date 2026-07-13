import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cancelOwnedAgentRuntime, createMultiAgentRuntimeHandles } from "../extensions/agents-core/src/runtime.ts";
import { createDetachedJobLifecycleController } from "../src/core/detached-job-lifecycle.ts";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import { MultiAgentStore } from "../src/core/multi-agent-store.ts";
import { testProcessIdentity } from "./helpers/process-identity.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { force: true, recursive: true });
	}
});

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-detached-cancel-test-"));
	tempDirs.push(dir);
	return dir;
}

function createController(root: string, store: MultiAgentStore) {
	const controlDbPath = join(root, "control.sqlite");
	const sessionPath = join(root, "session.jsonl");
	store.setPersistenceSessionManager({
		getMetadataControlDbPath: () => controlDbPath,
		getSessionFile: () => sessionPath,
	} as never);
	const coordinator = new LifecycleCoordinator({
		controlDbPath,
		createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
		now: () => new Date().toISOString(),
		processIdentity: testProcessIdentity("detached-cancel-runtime"),
		sessionPath,
	});
	return createDetachedJobLifecycleController({
		artifactRoot: root,
		controlDbPath,
		coordinator,
		ownerSessionId: "detached-cancel-session",
		sessionPath,
		store,
	});
}

describe("detached runtime cancellation without an extension context", () => {
	// Regression: the interactive Escape path calls cancelOwnedAgentRuntime with no
	// ExtensionContext. cancelPersistedDetachedRuntime used to reject that with
	// "runtime_ownership_unavailable" via a `!ctx` guard, even though the lifecycle
	// coordinator never reads ctx. Cancelling a detached agent must now succeed.
	for (const agentType of ["pyrun", "bash"] as const) {
		it(`reaches the cancelling lifecycle for a detached ${agentType} agent`, async () => {
			const root = await createTempDir();
			const store = new MultiAgentStore();
			const controller = createController(root, store);

			const ownership = controller.register({
				agentType,
				cwd: root,
				displayName: agentType === "pyrun" ? "Pyrun evaluation" : "Bash command",
				jobId: store.allocateAgentIdForLifecycleCoordinator(),
				processIdentity: testProcessIdentity(`detached-${agentType}-runner`),
				workerHandleId: "4242",
			});
			expect(store.getAgent(ownership.agent.id)?.lifecycle).toBe("running");

			// Matches the interactive Escape call shape: no ExtensionContext argument.
			const cancelled = await cancelOwnedAgentRuntime(store, createMultiAgentRuntimeHandles(), ownership.agent.id);

			expect(cancelled.ok).toBe(true);
			expect(cancelled.agent?.lifecycle).toBe("cancelling");
			expect(store.getAgent(ownership.agent.id)?.lifecycle).toBe("cancelling");
		});
	}
});
