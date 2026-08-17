import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifecycleCoordinator } from "../src/core/lifecycle-coordinator.ts";
import type { ProcessIdentity } from "../src/core/runtime-process.ts";
import {
	getRuntimeProcessInstanceId,
	type MultiAgentRuntimeOwnershipIdentity,
	readMultiAgentAgent,
	recoverDeadMultiAgentRuntime,
	registerRuntimeMailboxListener,
} from "../src/core/session-control-db.ts";

const temporaryDirectories: string[] = [];

function createTempControlDb(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-superseded-runtime-recovery-"));
	temporaryDirectories.push(directory);
	return join(directory, "control.sqlite");
}

function currentRuntimeIdentity(): ProcessIdentity & { incarnation: string } {
	return JSON.parse(getRuntimeProcessInstanceId()) as ProcessIdentity & { incarnation: string };
}

function createCancellingChild(
	controlDbPath: string,
	sessionPath: string,
	ownerSessionId: string,
	processIdentity: ProcessIdentity,
) {
	const coordinator = new LifecycleCoordinator({
		controlDbPath,
		createAgentId: () => "agent_superseded",
		now: () => "2026-08-17T00:00:00.000Z",
		processIdentity,
		sessionPath,
	});
	const prepared = coordinator.prepareChild({
		agentType: "worker",
		cwd: "/repo",
		displayName: "Superseded runtime child",
		permission: { narrowed: true, policy: "on-request" },
	});
	const created = coordinator.commitRunningChild(prepared, ownerSessionId);
	if (!created.ok) throw new Error(`Could not create child: ${created.error}`);
	const ownedProcessIdentity = created.ownership.processIdentity;
	if (!ownedProcessIdentity) throw new Error("Created child has no runtime process identity");
	const ownership: MultiAgentRuntimeOwnershipIdentity = {
		agentId: created.ownership.agentId,
		owner: { agentId: created.ownership.owner.agentId, sessionId: ownerSessionId },
		processIdentity: ownedProcessIdentity,
		sessionPath: created.ownership.sessionPath,
	};
	const cancelling = coordinator.requestCancellation({
		agent: created.agent,
		ownership,
	});
	if (!cancelling.ok) throw new Error(`Could not cancel child: ${cancelling.error}`);
	return { agent: cancelling.agent, ownership };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("superseded runtime recovery", () => {
	it("settles cancellation owned by a prior incarnation of the current process", () => {
		const controlDbPath = createTempControlDb();
		const sessionPath = "/sessions/superseded-runtime.jsonl";
		const ownerSessionId = "supervisor-session";
		const currentIdentity = currentRuntimeIdentity();
		const priorIdentity = { ...currentIdentity, incarnation: "prior-runtime-incarnation" };
		const child = createCancellingChild(controlDbPath, sessionPath, ownerSessionId, priorIdentity);
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: ownerSessionId },
			currentIdentity.pid,
			sessionPath,
			{ runtimeInstanceId: JSON.stringify(currentIdentity) },
		);

		const recovered = recoverDeadMultiAgentRuntime(controlDbPath, {
			expectedOwner: child.ownership,
			nowIso: "2026-08-17T00:00:01.000Z",
			supervisor: { processIdentity: currentIdentity, sessionId: ownerSessionId },
		});

		expect(recovered).toMatchObject({
			agent: { error: { code: "lost_runtime" }, lifecycle: "aborted" },
			ok: true,
		});
		expect(readMultiAgentAgent(controlDbPath, sessionPath, child.agent.id)).toMatchObject({
			error: { code: "lost_runtime" },
			lifecycle: "aborted",
		});
	});

	it("rejects recovery while the exact current runtime still owns the child", () => {
		const controlDbPath = createTempControlDb();
		const sessionPath = "/sessions/current-runtime.jsonl";
		const ownerSessionId = "supervisor-session";
		const currentIdentity = currentRuntimeIdentity();
		const child = createCancellingChild(controlDbPath, sessionPath, ownerSessionId, currentIdentity);
		registerRuntimeMailboxListener(
			controlDbPath,
			{ agentId: null, sessionId: ownerSessionId },
			currentIdentity.pid,
			sessionPath,
			{ runtimeInstanceId: JSON.stringify(currentIdentity) },
		);

		expect(
			recoverDeadMultiAgentRuntime(controlDbPath, {
				expectedOwner: child.ownership,
				nowIso: "2026-08-17T00:00:01.000Z",
				supervisor: { processIdentity: currentIdentity, sessionId: ownerSessionId },
			}),
		).toEqual({ error: "owner_alive", ok: false });
		expect(readMultiAgentAgent(controlDbPath, sessionPath, child.agent.id)).toMatchObject({
			lifecycle: "cancelling",
		});
	});
});
