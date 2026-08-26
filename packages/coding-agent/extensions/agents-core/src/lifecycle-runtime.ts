import { LifecycleCoordinator } from "../../../src/core/lifecycle-coordinator.ts";
import type { MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import type { ProcessIdentity } from "../../../src/core/runtime-process.ts";
import { getRuntimeProcessInstanceId } from "../../../src/core/session-control-db.ts";

export const RUNTIME_PROCESS_IDENTITY = JSON.parse(getRuntimeProcessInstanceId()) as ProcessIdentity;

export function createLifecycleCoordinator(store: MultiAgentStore): LifecycleCoordinator | undefined {
	const persistence = store.getPersistenceTarget();
	if (!persistence) return undefined;
	return new LifecycleCoordinator({
		controlDbPath: persistence.controlDbPath,
		createAgentId: () => store.allocateAgentIdForLifecycleCoordinator(),
		now: () => new Date().toISOString(),
		processIdentity: RUNTIME_PROCESS_IDENTITY,
		sessionPath: persistence.sessionPath,
	});
}
