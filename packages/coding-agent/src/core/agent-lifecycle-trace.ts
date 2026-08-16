import type { AgentLifecycleState, AgentSnapshot } from "./multi-agent-store.ts";
import type { ProcessIdentity } from "./runtime-process.ts";
import type { MultiAgentRuntimeOwnership } from "./session-control-db.ts";
import { type FileEntry, loadEntriesFromFile } from "./session-manager.ts";
import { configureReadOnlySqliteDatabase, createReadOnlySqliteDatabase, type SqliteDatabase } from "./sqlite.ts";

const AGENT_START_CUSTOM_TYPE = "agent_start";
const AGENT_COMPLETE_CUSTOM_TYPE = "agent_complete";
const END_TURN_TOOL_NAME = "end_turn";

export type AgentLifecycleTraceEvent =
	| {
			kind: "agent_snapshot";
			lifecycle: AgentLifecycleState;
			revision: number;
			source: "control_db";
			timestamp: string;
			timestampSource: "agent.updatedAt";
	  }
	| {
			agentId: string;
			agentType: string;
			detached: boolean;
			kind: "descendant_admitted";
			parentId: string;
			source: "control_db";
			timestamp: string;
			timestampSource: "descendant.createdAt";
	  }
	| {
			agentId: string;
			kind: "descendant_snapshot";
			lifecycle: AgentLifecycleState;
			parentId: string;
			revision: number;
			source: "control_db";
			timestamp: string;
			timestampSource: "descendant.updatedAt";
	  }
	| {
			childSessionId?: string;
			entryId: string;
			kind: "parent_agent_complete" | "parent_agent_start";
			lifecycle?: AgentLifecycleState;
			source: "parent_transcript";
			timestamp: string;
			timestampSource: "entry.timestamp";
			transcriptPath?: string;
	  }
	| {
			entryId: string;
			kind: "child_end_turn";
			reason?: string;
			source: "child_transcript";
			timestamp: string;
			timestampSource: "entry.timestamp";
			toolCallId: string;
	  }
	| {
			agentId: string;
			attemptCount: number;
			claimId?: string;
			claimedAt?: string;
			deliveredAt?: string;
			eventKind: string;
			kind: "terminal_outbox";
			lastError?: string;
			source: "control_db";
			status: "claimed" | "delivered" | "pending" | "poisoned";
			terminalRevision: number;
			timestamp: string;
			timestampSource: "outbox.updated_at";
	  };

export interface AgentLifecycleTrace {
	events: AgentLifecycleTraceEvent[];
	ownership?: MultiAgentRuntimeOwnership;
}

export function formatAgentLifecycleTrace(trace: AgentLifecycleTrace): string {
	const lines = ["Lifecycle trace:", formatOwnership(trace.ownership)];
	lines.push(
		...trace.events.map((event) => `${event.timestamp} [${event.timestampSource}] ${formatTraceEvent(event)}`),
	);
	return lines.join("\n");
}

interface RuntimeOwnershipRow {
	agent_id: string;
	owner_agent_id: string | null;
	owner_session_id: string | null;
	process_identity: string | null;
	session_path: string;
}

interface TerminalOutboxRow {
	agent_id: string;
	attempt_count: number;
	claim_id: string | null;
	claimed_at: string | null;
	delivered_at: string | null;
	event_kind: string;
	last_error: string | null;
	status: "claimed" | "delivered" | "pending" | "poisoned";
	terminal_revision: number;
	updated_at: string;
}

interface ParentAgentRecordData {
	agentId?: unknown;
	childSessionId?: unknown;
	lifecycle?: unknown;
	transcriptPath?: unknown;
}

const AGENT_LIFECYCLE_STATES = new Set<AgentLifecycleState>([
	"running",
	"waiting_for_input",
	"steering_pending",
	"cancelling",
	"completed",
	"failed",
	"aborted",
]);

const TRACE_EVENT_ORDER: Record<AgentLifecycleTraceEvent["kind"], number> = {
	agent_snapshot: 0,
	parent_agent_start: 1,
	descendant_admitted: 2,
	descendant_snapshot: 3,
	child_end_turn: 4,
	terminal_outbox: 5,
	parent_agent_complete: 6,
};

export function readAgentLifecycleTrace(input: {
	agent: AgentSnapshot;
	agents: AgentSnapshot[];
	controlDbPath: string;
	sessionPath: string;
}): AgentLifecycleTrace {
	const database = createReadOnlySqliteDatabase(input.controlDbPath);
	try {
		configureReadOnlySqliteDatabase(database);
		const ownership = readRuntimeOwnership(database, input.sessionPath, input.agent.id);
		const descendants = listTraceDescendants(input.agents, input.agent.id);
		const events = [
			agentSnapshotEvent(input.agent),
			...descendants.flatMap(descendantTraceEvents),
			...readParentAgentEvents(input.sessionPath, input.agent.id),
			...readChildEndTurnEvents(input.agent),
			...readTerminalOutboxEvents(
				database,
				input.sessionPath,
				[input.agent, ...descendants].map((agent) => agent.id),
			),
		].sort(compareTraceEvents);
		return { events, ownership };
	} finally {
		database.close();
	}
}

function agentSnapshotEvent(agent: AgentSnapshot): AgentLifecycleTraceEvent {
	return {
		kind: "agent_snapshot",
		lifecycle: agent.lifecycle,
		revision: agent.revision,
		source: "control_db",
		timestamp: agent.updatedAt,
		timestampSource: "agent.updatedAt",
	};
}

type TraceDescendant = AgentSnapshot & { parentId: string };

function hasParentAgentId(agent: AgentSnapshot): agent is TraceDescendant {
	return typeof agent.parentId === "string";
}

function listTraceDescendants(agents: AgentSnapshot[], parentId: string): TraceDescendant[] {
	const childrenByParent = new Map<string, TraceDescendant[]>();
	for (const agent of agents) {
		if (!hasParentAgentId(agent)) continue;
		const children = childrenByParent.get(agent.parentId) ?? [];
		children.push(agent);
		childrenByParent.set(agent.parentId, children);
	}

	const descendants: TraceDescendant[] = [];
	const pendingParentIds = [parentId];
	const visitedAgentIds = new Set<string>(pendingParentIds);
	while (pendingParentIds.length > 0) {
		const currentParentId = pendingParentIds.shift();
		if (!currentParentId) continue;
		for (const child of childrenByParent.get(currentParentId) ?? []) {
			if (visitedAgentIds.has(child.id)) continue;
			visitedAgentIds.add(child.id);
			descendants.push(child);
			pendingParentIds.push(child.id);
		}
	}
	return descendants;
}

function descendantTraceEvents(agent: TraceDescendant): AgentLifecycleTraceEvent[] {
	return [
		{
			agentId: agent.id,
			agentType: agent.agentType,
			detached: agent.detached === true,
			kind: "descendant_admitted",
			parentId: agent.parentId,
			source: "control_db",
			timestamp: agent.createdAt,
			timestampSource: "descendant.createdAt",
		},
		{
			agentId: agent.id,
			kind: "descendant_snapshot",
			lifecycle: agent.lifecycle,
			parentId: agent.parentId,
			revision: agent.revision,
			source: "control_db",
			timestamp: agent.updatedAt,
			timestampSource: "descendant.updatedAt",
		},
	];
}

function readRuntimeOwnership(
	database: SqliteDatabase,
	sessionPath: string,
	agentId: string,
): MultiAgentRuntimeOwnership | undefined {
	const row = database
		.prepare(
			`SELECT session_path, agent_id, process_identity, owner_session_id, owner_agent_id
			 FROM multi_agent_runtime_owners
			 WHERE session_path = ? AND agent_id = ?`,
		)
		.get(sessionPath, agentId) as RuntimeOwnershipRow | undefined;
	if (!row) return undefined;
	return {
		agentId: row.agent_id,
		owner: {
			agentId: row.owner_agent_id,
			sessionId: row.owner_session_id ?? undefined,
		},
		processIdentity: parseProcessIdentity(row.process_identity),
		sessionPath: row.session_path,
	};
}

function readTerminalOutboxEvents(
	database: SqliteDatabase,
	sessionPath: string,
	agentIds: string[],
): AgentLifecycleTraceEvent[] {
	return agentIds.flatMap((agentId) => {
		const rows = database
			.prepare(
				`SELECT agent_id, terminal_revision, event_kind, status, claim_id, claimed_at, delivered_at,
				        attempt_count, last_error, updated_at
				 FROM multi_agent_terminal_outbox
				 WHERE session_path = ? AND agent_id = ?
				 ORDER BY terminal_revision, event_kind`,
			)
			.all(sessionPath, agentId) as TerminalOutboxRow[];
		return rows.map((row) => ({
			agentId: row.agent_id,
			attemptCount: row.attempt_count,
			claimId: row.claim_id ?? undefined,
			claimedAt: row.claimed_at ?? undefined,
			deliveredAt: row.delivered_at ?? undefined,
			eventKind: row.event_kind,
			kind: "terminal_outbox" as const,
			lastError: row.last_error ?? undefined,
			source: "control_db" as const,
			status: row.status,
			terminalRevision: row.terminal_revision,
			timestamp: row.updated_at,
			timestampSource: "outbox.updated_at" as const,
		}));
	});
}

function readParentAgentEvents(sessionPath: string, agentId: string): AgentLifecycleTraceEvent[] {
	return loadEntriesFromFile(sessionPath).flatMap((entry) => parentAgentEvent(entry, agentId));
}

function parentAgentEvent(entry: FileEntry, agentId: string): AgentLifecycleTraceEvent[] {
	if (
		entry.type !== "custom" ||
		(entry.customType !== AGENT_START_CUSTOM_TYPE && entry.customType !== AGENT_COMPLETE_CUSTOM_TYPE)
	) {
		return [];
	}
	const data = toParentAgentRecordData(entry.data);
	if (data.agentId !== agentId) return [];
	return [
		{
			childSessionId: stringValue(data.childSessionId),
			entryId: entry.id,
			kind: entry.customType === AGENT_START_CUSTOM_TYPE ? "parent_agent_start" : "parent_agent_complete",
			lifecycle: lifecycleValue(data.lifecycle),
			source: "parent_transcript",
			timestamp: entry.timestamp,
			timestampSource: "entry.timestamp",
			transcriptPath: stringValue(data.transcriptPath),
		},
	];
}

function readChildEndTurnEvents(agent: AgentSnapshot): AgentLifecycleTraceEvent[] {
	const transcript = agent.transcript;
	if (!transcript?.path) return [];
	const entries = loadEntriesFromFile(transcript.path);
	const header = entries.find((entry) => entry.type === "session");
	if (!header || header.id !== transcript.sessionId) return [];
	return entries.filter((entry) => entry.timestamp >= header.timestamp).flatMap(childEndTurnEvent);
}

function childEndTurnEvent(entry: FileEntry): AgentLifecycleTraceEvent[] {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
	const message = entry.message;
	if (message.toolName !== END_TURN_TOOL_NAME || message.isError) return [];
	return [
		{
			entryId: entry.id,
			kind: "child_end_turn",
			reason: readEndTurnReason(message.details),
			source: "child_transcript",
			timestamp: entry.timestamp,
			timestampSource: "entry.timestamp",
			toolCallId: message.toolCallId,
		},
	];
}

function compareTraceEvents(left: AgentLifecycleTraceEvent, right: AgentLifecycleTraceEvent): number {
	const timestampOrder = left.timestamp.localeCompare(right.timestamp);
	if (timestampOrder !== 0) return timestampOrder;
	return TRACE_EVENT_ORDER[left.kind] - TRACE_EVENT_ORDER[right.kind];
}

function formatOwnership(ownership: MultiAgentRuntimeOwnership | undefined): string {
	if (!ownership) return "runtime_ownership absent";
	const ownerAgentId = ownership.owner.agentId ?? "main";
	const ownerSessionId = ownership.owner.sessionId ?? "unknown";
	const process = ownership.processIdentity
		? `${ownership.processIdentity.pid}:${ownership.processIdentity.startTimeTicks}:${ownership.processIdentity.incarnation ?? "legacy"}`
		: "unbound";
	return `runtime_ownership owner=${ownerSessionId}:${ownerAgentId} process=${process}`;
}

function formatTraceEvent(event: AgentLifecycleTraceEvent): string {
	switch (event.kind) {
		case "agent_snapshot":
			return `agent_snapshot lifecycle=${event.lifecycle} revision=${event.revision}`;
		case "descendant_admitted":
			return `descendant_admitted agent=${event.agentId} parent=${event.parentId} type=${event.agentType} detached=${event.detached}`;
		case "descendant_snapshot":
			return `descendant_snapshot agent=${event.agentId} parent=${event.parentId} lifecycle=${event.lifecycle} revision=${event.revision}`;
		case "parent_agent_start":
		case "parent_agent_complete":
			return `${event.kind} lifecycle=${event.lifecycle ?? "unknown"} entry=${event.entryId}`;
		case "child_end_turn":
			return `child_end_turn reason=${JSON.stringify(event.reason ?? "")} entry=${event.entryId}`;
		case "terminal_outbox":
			return `terminal_outbox agent=${event.agentId} event=${event.eventKind} revision=${event.terminalRevision} status=${event.status}`;
	}
}

function parseProcessIdentity(serialized: string | null): ProcessIdentity | undefined {
	if (!serialized) return undefined;
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as { incarnation?: unknown; pid?: unknown; startTimeTicks?: unknown };
	if (typeof candidate.pid !== "number" || typeof candidate.startTimeTicks !== "number") return undefined;
	return {
		incarnation: typeof candidate.incarnation === "string" ? candidate.incarnation : undefined,
		pid: candidate.pid,
		startTimeTicks: candidate.startTimeTicks,
	};
}

function toParentAgentRecordData(value: unknown): ParentAgentRecordData {
	return value && typeof value === "object" ? (value as ParentAgentRecordData) : {};
}

function lifecycleValue(value: unknown): AgentLifecycleState | undefined {
	if (typeof value !== "string") return undefined;
	return AGENT_LIFECYCLE_STATES.has(value as AgentLifecycleState) ? (value as AgentLifecycleState) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readEndTurnReason(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const reason = (value as { reason?: unknown }).reason;
	return typeof reason === "string" ? reason : undefined;
}
