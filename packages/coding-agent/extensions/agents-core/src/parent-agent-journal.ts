import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { AgentLifecycleState, AgentSnapshot, MultiAgentStore } from "../../../src/core/multi-agent-store.ts";
import { type FileEntry, loadEntriesFromFile } from "../../../src/core/session-manager.ts";

const AGENT_START_CUSTOM_TYPE = "agent_start";
const AGENT_COMPLETE_CUSTOM_TYPE = "agent_complete";
const MAIN_THREAD_AGENT_ID = "main";

type ParentAgentRecordData = {
	agentId: string;
	childSessionId: string;
	lifecycle: AgentLifecycleState;
	transcriptPath: string;
};

export type ParentAgentJournalWriter = Pick<ExtensionAPI, "appendEntry">;

export function isTerminalAgentLifecycle(lifecycle: AgentLifecycleState): boolean {
	return lifecycle === "completed" || lifecycle === "failed" || lifecycle === "aborted";
}

function appendParentAgentRecord(
	pi: ParentAgentJournalWriter,
	customType: typeof AGENT_START_CUSTOM_TYPE | typeof AGENT_COMPLETE_CUSTOM_TYPE,
	agent: AgentSnapshot,
): void {
	const childSessionId = agent.transcript?.sessionId;
	const transcriptPath = agent.transcript?.path;
	if (!childSessionId || !transcriptPath) {
		throw new Error(`Cannot persist ${customType} for ${agent.id} without transcript identity`);
	}
	pi.appendEntry(customType, {
		agentId: agent.id,
		childSessionId,
		lifecycle: agent.lifecycle,
		transcriptPath,
	} satisfies ParentAgentRecordData);
}

export function appendParentAgentStart(pi: ParentAgentJournalWriter, agent: AgentSnapshot): void {
	appendParentAgentRecord(pi, AGENT_START_CUSTOM_TYPE, agent);
}

export function appendParentAgentCompletion(pi: ParentAgentJournalWriter, agent: AgentSnapshot): void {
	appendParentAgentRecord(pi, AGENT_COMPLETE_CUSTOM_TYPE, agent);
}

function readActiveParentAgentIdsFromEntries(entries: readonly FileEntry[]): Set<string> {
	const started = new Set<string>();
	const completed = new Set<string>();
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			(entry.customType !== AGENT_START_CUSTOM_TYPE && entry.customType !== AGENT_COMPLETE_CUSTOM_TYPE)
		) {
			continue;
		}
		const data = entry.data as Partial<ParentAgentRecordData> | undefined;
		if (typeof data?.agentId !== "string") continue;
		if (entry.customType === AGENT_START_CUSTOM_TYPE) started.add(data.agentId);
		else completed.add(data.agentId);
	}
	for (const agentId of completed) started.delete(agentId);
	return started;
}

export function readActiveParentAgentIds(ctx: ExtensionContext): Set<string> {
	return readActiveParentAgentIdsFromEntries(ctx.sessionManager.getEntries());
}

function listDirectActiveAgents(store: MultiAgentStore, ctx: ExtensionContext): AgentSnapshot[] {
	const parentId = ctx.multiAgentAgentId ?? MAIN_THREAD_AGENT_ID;
	return store.listActiveAgents().filter((agent) => (agent.parentId ?? MAIN_THREAD_AGENT_ID) === parentId);
}

function appendParentAgentStarts(pi: ParentAgentJournalWriter, agents: AgentSnapshot[]): void {
	for (const agent of agents) appendParentAgentStart(pi, agent);
}

function refreshActiveParentAgentRecordsAfterCompaction(
	pi: ParentAgentJournalWriter,
	store: MultiAgentStore,
	ctx: ExtensionContext,
): void {
	const journaledAgentIds = readActiveParentAgentIds(ctx);
	const activeJournaledAgents = listDirectActiveAgents(store, ctx).filter((agent) => journaledAgentIds.has(agent.id));
	appendParentAgentStarts(pi, activeJournaledAgents);
}

export function registerParentAgentCompactionRefresh(pi: ExtensionAPI, store: MultiAgentStore): void {
	pi.on?.("session_compact", (_event, ctx) => {
		refreshActiveParentAgentRecordsAfterCompaction(pi, store, ctx);
	});
}

export function restoreCompactedParentAgentRecords(
	pi: ParentAgentJournalWriter,
	store: MultiAgentStore,
	ctx: ExtensionContext,
): void {
	const journaledAgentIds = readActiveParentAgentIds(ctx);
	const missingJournalAgents = listDirectActiveAgents(store, ctx).filter((agent) => !journaledAgentIds.has(agent.id));
	if (missingJournalAgents.length === 0) return;
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return;
	const persistedAgentIds = readActiveParentAgentIdsFromEntries(loadEntriesFromFile(sessionFile));
	const persistedMissingJournalAgents = missingJournalAgents.filter((agent) => persistedAgentIds.has(agent.id));
	appendParentAgentStarts(pi, persistedMissingJournalAgents);
}
