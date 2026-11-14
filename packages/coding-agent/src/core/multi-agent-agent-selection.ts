import { isActiveLifecycle, listMailboxMessages } from "./multi-agent-mailbox-state.ts";
import { copyAgent } from "./multi-agent-snapshots.ts";
import type { MultiAgentStore } from "./multi-agent-store.ts";
import type {
	ActiveAgentTargetSelectionResult,
	AgentMetadataCommandResult,
	AgentNode,
	AgentRowProjection,
	AgentSlotProjection,
	AgentSnapshot,
	AgentViewSelectionResult,
	MultiAgentProjectionSnapshot,
} from "./multi-agent-types.ts";

export function selectAgentView(store: MultiAgentStore, agentId: string): AgentSnapshot | undefined {
	const result = selectAgentViewWithStatus(store, agentId);
	return result.ok ? result.agent : undefined;
}

export function selectAgentViewWithStatus(store: MultiAgentStore, agentId: string): AgentViewSelectionResult {
	const agent = store.agents.get(agentId);
	if (!agent) {
		return { ok: false, error: "not_found", agentId };
	}

	store.selectedAgentId = agent.id;

	return { ok: true, agent: copyAgent(agent) };
}

export function selectActiveAgentTarget(store: MultiAgentStore, agentId: string): AgentSnapshot | undefined {
	const result = selectActiveAgentTargetWithStatus(store, agentId);
	return result.ok ? result.agent : undefined;
}

export function selectActiveAgentTargetWithStatus(
	store: MultiAgentStore,
	agentId: string,
): ActiveAgentTargetSelectionResult {
	const agent = store.agents.get(agentId);
	if (!agent) {
		return { ok: false, error: "not_found", agentId };
	}
	if (!isActiveLifecycle(agent.lifecycle)) {
		return { ok: false, error: "inactive", agent: copyAgent(agent) };
	}

	store.selectedAgentId = agent.id;
	return { ok: true, agent: copyAgent(agent) };
}

export function selectAgentSlot(store: MultiAgentStore, slotIndex: number): AgentSnapshot | undefined {
	const result = selectAgentSlotWithStatus(store, slotIndex);
	return result.ok ? result.agent : undefined;
}

export function selectAgentSlotWithStatus(store: MultiAgentStore, slotIndex: number): AgentViewSelectionResult {
	const selectedAgent = findAgentForSlotSelection(store, slotIndex);
	if (!selectedAgent) {
		return { ok: false, error: "not_found", agentId: String(slotIndex) };
	}

	store.selectedAgentId = selectedAgent.id;
	return { ok: true, agent: copyAgent(selectedAgent) };
}

export function selectActiveAgentSlotTarget(store: MultiAgentStore, slotIndex: number): AgentSnapshot | undefined {
	const result = selectActiveAgentSlotTargetWithStatus(store, slotIndex);
	return result.ok ? result.agent : undefined;
}

export function selectActiveAgentSlotTargetWithStatus(
	store: MultiAgentStore,
	slotIndex: number,
): ActiveAgentTargetSelectionResult {
	const selectedAgent = findAgentForSlotSelection(store, slotIndex);
	if (!selectedAgent) {
		return { ok: false, error: "not_found", agentId: String(slotIndex) };
	}
	if (!isActiveLifecycle(selectedAgent.lifecycle)) {
		return { ok: false, error: "inactive", agent: copyAgent(selectedAgent) };
	}

	store.selectedAgentId = selectedAgent.id;
	return { ok: true, agent: copyAgent(selectedAgent) };
}

export function getSelectedAgentId(store: MultiAgentStore): string | undefined {
	return store.selectedAgentId;
}

export function clearSelectedAgentView(store: MultiAgentStore): void {
	store.selectedAgentId = undefined;
}

export function getAgent(store: MultiAgentStore, agentId: string): AgentSnapshot | undefined {
	const agent = store.agents.get(agentId);
	return agent ? copyAgent(agent) : undefined;
}

export function listAgents(store: MultiAgentStore): AgentSnapshot[] {
	return Array.from(store.agents.values(), copyAgent);
}

export function listDescendants(store: MultiAgentStore, parentId: string): AgentSnapshot[] {
	const descendants: AgentNode[] = [];

	const visitChildren = (currentParentId: string) => {
		for (const agent of store.agents.values()) {
			if (agent.parentId !== currentParentId) {
				continue;
			}

			descendants.push(agent);
			visitChildren(agent.id);
		}
	};

	visitChildren(parentId);

	return descendants.map(copyAgent);
}

export function getProjectionSnapshot(store: MultiAgentStore): MultiAgentProjectionSnapshot {
	return {
		activeCount: getActiveAgentCount(store),
		agents: listAgents(store),
		mailboxMessages: listMailboxMessages(store),
		rows: listRowProjections(store),
		selectedAgentId: store.selectedAgentId,
		slots: listSlotProjections(store),
	};
}

export function listActiveAgents(store: MultiAgentStore): AgentSnapshot[] {
	return listAgents(store).filter((agent) => isActiveLifecycle(agent.lifecycle));
}

export function getActiveAgentCount(store: MultiAgentStore): number {
	let activeCount = 0;

	for (const agent of store.agents.values()) {
		if (isActiveLifecycle(agent.lifecycle)) {
			activeCount += 1;
		}
	}

	return activeCount;
}

export function listSlotProjections(store: MultiAgentStore): AgentSlotProjection[] {
	return Array.from(store.agents.values())
		.filter((agent): agent is AgentNode & { slot: NonNullable<AgentNode["slot"]> } => agent.slot !== undefined)
		.map((agent) => ({
			agentId: agent.id,
			agent: copyAgent(agent),
			index: agent.slot.index,
			pinned: agent.slot.pinned,
			revision: agent.revision,
		}))
		.sort((left, right) => left.index - right.index || left.agentId.localeCompare(right.agentId));
}

export function listRowProjections(store: MultiAgentStore): AgentRowProjection[] {
	return Array.from(store.agents.values()).map((agent) => ({
		active: isActiveLifecycle(agent.lifecycle),
		agentId: agent.id,
		displayName: agent.displayName,
		lifecycle: agent.lifecycle,
		revision: agent.revision,
		selected: store.selectedAgentId === agent.id,
		slotIndex: agent.slot?.index,
		workerAdapter: agent.worker?.adapter,
	}));
}

export function findAgentForSlotSelection(store: MultiAgentStore, slotIndex: number): AgentNode | undefined {
	const pinnedAgent = findActiveAgentByPinnedSlot(store, slotIndex);
	return pinnedAgent ?? listActiveAgentNodes(store)[slotIndex - 1];
}

export function findActiveAgentByPinnedSlot(store: MultiAgentStore, slotIndex: number): AgentNode | undefined {
	for (const agent of store.agents.values()) {
		if (agent.slot?.index === slotIndex && isActiveLifecycle(agent.lifecycle)) {
			return agent;
		}
	}

	return undefined;
}

export function listActiveAgentNodes(store: MultiAgentStore): AgentNode[] {
	return Array.from(store.agents.values()).filter((agent) => isActiveLifecycle(agent.lifecycle));
}

export function pinAgentSlot(
	store: MultiAgentStore,
	agentId: string,
	expectedRevision: number,
	slotIndex: number,
): AgentMetadataCommandResult {
	const current = store.agents.get(agentId);
	if (!current) {
		return { ok: false, error: "not_found", agentId };
	}

	if (current.revision !== expectedRevision) {
		return {
			ok: false,
			error: "stale_revision",
			current: copyAgent(current),
			projection: getProjectionSnapshot(store),
		};
	}

	const occupant = findSlotOccupant(store, slotIndex, current.id);
	if (occupant) {
		return {
			ok: false,
			error: "slot_conflict",
			current: copyAgent(current),
			occupant: copyAgent(occupant),
			projection: getProjectionSnapshot(store),
		};
	}

	const updated = store.updateAgentMetadata(current, {
		slot: { index: slotIndex, pinned: true },
	});
	return { ok: true, agent: copyAgent(updated) };
}

export function clearAgentSlot(
	store: MultiAgentStore,
	agentId: string,
	expectedRevision: number,
): AgentMetadataCommandResult {
	const current = store.agents.get(agentId);
	if (!current) {
		return { ok: false, error: "not_found", agentId };
	}

	if (current.revision !== expectedRevision) {
		return {
			ok: false,
			error: "stale_revision",
			current: copyAgent(current),
			projection: getProjectionSnapshot(store),
		};
	}

	const updated = store.updateAgentMetadata(current, {
		slot: undefined,
	});
	return { ok: true, agent: copyAgent(updated) };
}

export function findSlotOccupant(
	store: MultiAgentStore,
	slotIndex: number,
	excludedAgentId: string,
): AgentNode | undefined {
	for (const agent of store.agents.values()) {
		if (agent.id !== excludedAgentId && agent.slot?.index === slotIndex) {
			return agent;
		}
	}

	return undefined;
}
