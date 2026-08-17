import { isActiveLifecycle, type AgentSnapshot, type MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { readMultiAgentState } from "../../../src/core/session-control-db.ts";

const DESCENDANT_RECONCILIATION_POLL_INTERVAL_MS = 250;

export async function waitForActiveDescendants(
	store: MultiAgentStore,
	agentId: string,
	signal?: AbortSignal,
): Promise<void> {
	const refreshAndCheckActiveDescendants = () => {
		refreshPersistedDescendantSnapshots(store, agentId);
		return store.listDescendants(agentId).some((agent) => isActiveLifecycle(agent.lifecycle));
	};
	const canStopForAbort = () => signal?.aborted === true && store.getAgent(agentId)?.lifecycle !== "cancelling";
	const shouldFinish = () => !refreshAndCheckActiveDescendants() || canStopForAbort();
	if (shouldFinish()) return;
	await waitForDescendantStateChange(store, shouldFinish, signal);
}

function waitForDescendantStateChange(
	store: MultiAgentStore,
	shouldFinish: () => boolean,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolve) => {
		let settled = false;
		let pollTimer: ReturnType<typeof setInterval> | undefined;
		let unsubscribe = () => {};
		function finish() {
			if (settled) return;
			settled = true;
			unsubscribe();
			if (pollTimer) clearInterval(pollTimer);
			signal?.removeEventListener("abort", checkState);
			resolve();
		}
		function checkState() {
			if (shouldFinish()) finish();
		}
		unsubscribe = store.subscribeAgentUpdates(checkState);
		pollTimer = setInterval(checkState, DESCENDANT_RECONCILIATION_POLL_INTERVAL_MS);
		signal?.addEventListener("abort", checkState, { once: true });
		checkState();
	});
}

function refreshPersistedDescendantSnapshots(store: MultiAgentStore, agentId: string): void {
	const persistence = store.getPersistenceTarget();
	if (!persistence) return;
	const persistedState = readMultiAgentState(persistence.controlDbPath, persistence.sessionPath);
	if (!persistedState) return;
	const descendants = listDescendantSnapshots(persistedState.agents as AgentSnapshot[], agentId);
	for (const descendant of descendants) {
		const current = store.getAgent(descendant.id);
		if (!current || descendant.revision > current.revision) {
			store.publishLifecycleCoordinatorSnapshot(descendant);
		}
	}
}

function listDescendantSnapshots(agents: AgentSnapshot[], ancestorId: string): AgentSnapshot[] {
	const childrenByParent = new Map<string | undefined, AgentSnapshot[]>();
	for (const agent of agents) {
		const siblings = childrenByParent.get(agent.parentId) ?? [];
		siblings.push(agent);
		childrenByParent.set(agent.parentId, siblings);
	}
	const descendants: AgentSnapshot[] = [];
	const pendingParentIds = [ancestorId];
	while (pendingParentIds.length > 0) {
		const parentId = pendingParentIds.pop();
		if (parentId === undefined) break;
		for (const child of childrenByParent.get(parentId) ?? []) {
			descendants.push(child);
			pendingParentIds.push(child.id);
		}
	}
	return descendants;
}
