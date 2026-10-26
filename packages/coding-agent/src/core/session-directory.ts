import { isPiRuntimeProcessAlive } from "./runtime-process.ts";
import {
	listActiveSessionMetadata,
	listRuntimeMailboxListeners,
	listSessionHealth,
	retireRuntimeMailboxListener,
	type SessionMetadata,
	writeSessionHealth,
} from "./session-control-db.ts";
import {
	deriveLiveStatus,
	emptySessionHealth,
	endSessionHealth,
	isSessionEligibleToReceive,
	parseGoalObjective,
	SESSION_CHECK_STALE_MS,
	type SessionDirectoryEntry,
	type SessionHealthRecord,
} from "./session-health.ts";

export interface SessionDirectoryOptions {
	now?: () => Date;
	includeEnded?: boolean;
	isRuntimeProcessAlive?: (pid: number) => boolean;
}

function resolveNow(options?: SessionDirectoryOptions): Date {
	return options?.now?.() ?? new Date();
}

interface CurrentMainSessionBinding {
	pid: number;
	updatedAt: string;
	heartbeatFresh: boolean;
}

function healthBySessionId(controlDbPath: string): Map<string, SessionHealthRecord> {
	const map = new Map<string, SessionHealthRecord>();
	for (const health of listSessionHealth(controlDbPath)) {
		map.set(health.sessionId, health);
	}
	return map;
}

function newestMetadataBySessionId(metadata: SessionMetadata[]): SessionMetadata[] {
	const seenSessionIds = new Set<string>();
	return metadata.filter((row) => {
		if (seenSessionIds.has(row.id)) return false;
		seenSessionIds.add(row.id);
		return true;
	});
}

export function reconcileSessionRuntimeBindings(controlDbPath: string, options: SessionDirectoryOptions = {}): void {
	const now = resolveNow(options);
	reconcileCurrentMainSessionBindings(controlDbPath, now, options.isRuntimeProcessAlive ?? isPiRuntimeProcessAlive);
}

function reconcileCurrentMainSessionBindings(
	controlDbPath: string,
	now: Date,
	isRuntimeProcessAlive: (pid: number) => boolean,
): Map<string, CurrentMainSessionBinding> {
	const listeners = listRuntimeMailboxListeners(controlDbPath)
		.filter((listener) => listener.agentId === null)
		.sort((left, right) => {
			const updatedAtOrder = right.updatedAt.localeCompare(left.updatedAt);
			if (updatedAtOrder !== 0) return updatedAtOrder;
			return left.sessionId.localeCompare(right.sessionId);
		});
	const seenPids = new Set<number>();
	const bindings = new Map<string, CurrentMainSessionBinding>();
	for (const listener of listeners) {
		const heartbeatFresh = bindingHeartbeatIsFresh(listener, now.getTime());
		const isSuperseded = seenPids.has(listener.pid);
		const processUnavailable = !isRuntimeProcessAlive(listener.pid);
		if (isSuperseded || processUnavailable) {
			retireRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: listener.sessionId }, listener.pid);
			continue;
		}
		seenPids.add(listener.pid);
		bindings.set(listener.sessionId, {
			pid: listener.pid,
			updatedAt: listener.updatedAt,
			heartbeatFresh,
		});
	}
	return bindings;
}

function bindingHeartbeatIsFresh(binding: Pick<CurrentMainSessionBinding, "updatedAt">, nowMs: number): boolean {
	const heartbeatMs = Date.parse(binding.updatedAt);
	const heartbeatAgeMs = nowMs - heartbeatMs;
	return Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs >= 0 && heartbeatAgeMs <= SESSION_CHECK_STALE_MS;
}

function synchronizedBoundSessionHealth(
	existing: SessionHealthRecord,
	binding: CurrentMainSessionBinding,
	nowIso: string,
): SessionHealthRecord | undefined {
	const sameGeneration = existing.pid === binding.pid && existing.agentGeneration > 0;
	const agentGeneration = sameGeneration ? existing.agentGeneration : existing.agentGeneration + 1;
	const checkStatus = binding.heartbeatFresh ? "ok" : "timeout";
	const lastCheckedAt = binding.heartbeatFresh ? binding.updatedAt : nowIso;
	const alreadySynced =
		existing.pid === binding.pid &&
		existing.lastActiveAt === binding.updatedAt &&
		existing.lastCheckedAt === lastCheckedAt &&
		existing.checkStatus === checkStatus &&
		existing.checkedGeneration === agentGeneration;
	if (alreadySynced) return undefined;
	return {
		...existing,
		pid: binding.pid,
		agentGeneration,
		lastActiveAt: binding.updatedAt,
		lastCheckedAt,
		checkStatus,
		checkedGeneration: agentGeneration,
		checkLatencyMs: 0,
		updatedAt: nowIso,
	};
}

function syncBoundSessionHealth(
	controlDbPath: string,
	sessionId: string,
	binding: CurrentMainSessionBinding,
	healthMap: Map<string, SessionHealthRecord>,
	now: Date,
): void {
	const nowIso = now.toISOString();
	const existing = healthMap.get(sessionId) ?? emptySessionHealth(sessionId, nowIso);
	const next = synchronizedBoundSessionHealth(existing, binding, nowIso);
	if (!next) return;
	writeSessionHealth(controlDbPath, next);
	healthMap.set(sessionId, next);
}

function retireUnboundSessionHealthIfNeeded(
	controlDbPath: string,
	metadata: SessionMetadata,
	healthMap: Map<string, SessionHealthRecord>,
	bindings: Map<string, CurrentMainSessionBinding>,
	nowIso: string,
): void {
	const existing = healthMap.get(metadata.id) ?? emptySessionHealth(metadata.id, nowIso);
	if (bindings.has(metadata.id) || existing.pid === null) {
		healthMap.set(metadata.id, existing);
		return;
	}
	const retired = endSessionHealth(existing, nowIso);
	writeSessionHealth(controlDbPath, retired);
	healthMap.set(metadata.id, retired);
}

function ensureHealthSyncedFromListeners(
	controlDbPath: string,
	metadata: SessionMetadata[],
	healthMap: Map<string, SessionHealthRecord>,
	bindings: Map<string, CurrentMainSessionBinding>,
	now: Date,
): void {
	const nowIso = now.toISOString();
	for (const [sessionId, binding] of bindings) {
		syncBoundSessionHealth(controlDbPath, sessionId, binding, healthMap, now);
	}
	for (const row of metadata) {
		retireUnboundSessionHealthIfNeeded(controlDbPath, row, healthMap, bindings, nowIso);
	}
}

function toDirectoryEntry(metadata: SessionMetadata, health: SessionHealthRecord, now: Date): SessionDirectoryEntry {
	const lastActiveAt = health.lastActiveAt ?? metadata.modifiedAt;
	return {
		sessionId: metadata.id,
		sessionPath: metadata.sessionPath,
		pid: health.pid,
		status: deriveLiveStatus(health, lastActiveAt, now.getTime()),
		startedAt: metadata.createdAt,
		lastActiveAt,
		name: metadata.name ?? null,
		goal: parseGoalObjective(metadata.goalJson),
		cwd: metadata.cwd || null,
		lastCheckedAt: health.lastCheckedAt,
		checkStatus: health.checkStatus,
		checkLatencyMs: health.checkLatencyMs,
		agentGeneration: health.agentGeneration,
		checkedGeneration: health.checkedGeneration,
		eligibleToReceive: isSessionEligibleToReceive(health),
	};
}

export function listSessions(controlDbPath: string, options: SessionDirectoryOptions = {}): SessionDirectoryEntry[] {
	const now = resolveNow(options);
	const nowIso = now.toISOString();
	const metadata = newestMetadataBySessionId(
		listActiveSessionMetadata(controlDbPath).filter((row) => !row.isSubagent),
	);
	const healthMap = healthBySessionId(controlDbPath);
	const isRuntimeProcessAlive = options.isRuntimeProcessAlive ?? isPiRuntimeProcessAlive;
	const bindings = reconcileCurrentMainSessionBindings(controlDbPath, now, isRuntimeProcessAlive);
	ensureHealthSyncedFromListeners(controlDbPath, metadata, healthMap, bindings, now);
	return metadata
		.map((row) => toDirectoryEntry(row, healthMap.get(row.id) ?? emptySessionHealth(row.id, nowIso), now))
		.filter((entry) => options.includeEnded !== false || entry.status !== "ended");
}
