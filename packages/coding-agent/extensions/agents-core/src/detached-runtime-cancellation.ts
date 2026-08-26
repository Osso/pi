import {
	type AgentSnapshot,
	isActiveLifecycle,
	type MultiAgentStore,
} from "../../../src/core/multi-agent-store.ts";
import {
	readMultiAgentRuntimeOwnership,
	readMultiAgentState,
} from "../../../src/core/session-control-db.ts";
import { createLifecycleCoordinator } from "./lifecycle-runtime.ts";

export interface DetachedRuntimeCancellationOptions {
	reason?: string;
	suppressTerminalNotification?: boolean;
}

export type DetachedRuntimeCancellationResult =
	| { ok: true; agent: AgentSnapshot }
	| {
			ok: false;
			error: "runtime_ownership_unavailable" | "mutation_rejected";
			agent: AgentSnapshot;
	  };

export function requestDirectDetachedRuntimeCancellations(
	store: MultiAgentStore,
	parentAgentId: string,
	reason: string,
): void {
	const directDetachedRuntimes = readDirectDetachedRuntimeAgents(store, parentAgentId);
	for (const agent of directDetachedRuntimes) {
		const cancelled = requestPersistedDetachedRuntimeCancellation(store, agent, {
			reason,
			suppressTerminalNotification: true,
		});
		if (!cancelled.ok) {
			throw new Error(
				`Could not cancel detached runtime ${agent.id} during subagent terminal cleanup: ${cancelled.error}`,
			);
		}
	}
}

function readDirectDetachedRuntimeAgents(store: MultiAgentStore, parentAgentId: string): AgentSnapshot[] {
	const persistence = store.getPersistenceTarget();
	const agents = persistence
		? (readMultiAgentState(persistence.controlDbPath, persistence.sessionPath)?.agents as AgentSnapshot[] | undefined)
		: store.listDescendants(parentAgentId);
	if (!agents) throw new Error(`Could not read persisted descendants for ${parentAgentId}`);
	return agents.filter(
		(agent) =>
			agent.parentId === parentAgentId && isActiveLifecycle(agent.lifecycle) && isDetachedRuntimeAgent(agent),
	);
}

export function requestPersistedDetachedRuntimeCancellation(
	store: MultiAgentStore,
	agent: AgentSnapshot,
	options: DetachedRuntimeCancellationOptions,
): DetachedRuntimeCancellationResult {
	const persistence = store.getPersistenceTarget();
	const outputLabel = detachedRuntimeOutputLabel(agent);
	if (!persistence || !outputLabel) {
		return { ok: false, error: "runtime_ownership_unavailable", agent };
	}
	const ownership = readMultiAgentRuntimeOwnership(persistence.controlDbPath, persistence.sessionPath, agent.id);
	const coordinator = createLifecycleCoordinator(store);
	if (!ownership?.processIdentity || !ownership.owner.sessionId || !coordinator) {
		return { ok: false, error: "runtime_ownership_unavailable", agent };
	}
	const cancelled = coordinator.requestDetachedCancellation({
		agent,
		outputLabel,
		ownership,
		reason: options.reason,
		suppressTerminalNotification: options.suppressTerminalNotification,
	});
	if (!cancelled.ok) return { ok: false, error: "mutation_rejected", agent };
	store.publishLifecycleCoordinatorSnapshot(cancelled.agent);
	return { ok: true, agent: cancelled.agent };
}

export function isDetachedRuntimeAgent(agent: AgentSnapshot): boolean {
	return (
		agent.detached === true &&
		agent.worker?.adapter === "runtime" &&
		detachedRuntimeOutputLabel(agent) !== undefined
	);
}

function detachedRuntimeOutputLabel(agent: AgentSnapshot): "Bash output" | "Pyrun output" | undefined {
	if (agent.agentType !== "background") return undefined;
	const label = agent.result?.fileRefs?.find(
		(fileRef) => fileRef.label === "Bash output" || fileRef.label === "Pyrun output",
	)?.label;
	return label === "Bash output" || label === "Pyrun output" ? label : undefined;
}
