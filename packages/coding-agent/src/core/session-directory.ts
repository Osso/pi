import { randomUUID } from "node:crypto";
import {
	enqueueRuntimeMailboxMessage,
	listRuntimeMailboxListeners,
	listSessionHealth,
	listSessionMetadata,
	readSessionHealth,
	registerRuntimeMailboxListener,
	type SessionMetadata,
	upsertMultiAgentMailboxMessage,
	writeSessionHealth,
} from "./session-control-db.ts";
import {
	applyProcessCheck,
	deriveLiveStatus,
	emptySessionHealth,
	isSessionEligibleToReceive,
	isStickyDead,
	needsSessionCheck,
	parseGoalObjective,
	type SessionBroadcastResult,
	type SessionDirectoryEntry,
	type SessionHealthRecord,
} from "./session-health.ts";

export interface SessionDirectoryOptions {
	now?: () => Date;
	signalProcess?: (pid: number, signal: 0) => void;
	includeEnded?: boolean;
	touchCurrentSessionId?: string;
}

export interface BroadcastSessionFilters {
	sessionIds?: string[];
	cwd?: string;
	name?: string;
	status?: Array<"running" | "idle" | "ended">;
}

export interface BroadcastSessionsInput {
	message: string;
	filters?: BroadcastSessionFilters;
	senderSessionId: string;
	senderSessionPath: string;
	senderAgentId?: string | null;
}

function resolveNow(options?: SessionDirectoryOptions): Date {
	return options?.now?.() ?? new Date();
}

function healthBySessionId(controlDbPath: string): Map<string, SessionHealthRecord> {
	const map = new Map<string, SessionHealthRecord>();
	for (const health of listSessionHealth(controlDbPath)) {
		map.set(health.sessionId, health);
	}
	return map;
}

function ensureHealthSyncedFromListeners(
	controlDbPath: string,
	metadata: SessionMetadata[],
	healthMap: Map<string, SessionHealthRecord>,
	nowIso: string,
): void {
	const listeners = listRuntimeMailboxListeners(controlDbPath).filter((listener) => listener.agentId === null);
	for (const listener of listeners) {
		const existing = healthMap.get(listener.sessionId) ?? emptySessionHealth(listener.sessionId, nowIso);
		if (existing.pid === listener.pid && existing.agentGeneration > 0) {
			const next = {
				...existing,
				pid: listener.pid,
				lastActiveAt: existing.lastActiveAt ?? listener.updatedAt,
				updatedAt: nowIso,
			};
			if (existing.pid !== next.pid || existing.lastActiveAt !== next.lastActiveAt) {
				writeSessionHealth(controlDbPath, next);
				healthMap.set(listener.sessionId, next);
			}
			continue;
		}
		// Rerun registration helper so generation advancement stays centralized with listener writes.
		registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId: listener.sessionId }, listener.pid);
		const refreshed = readSessionHealth(controlDbPath, listener.sessionId);
		if (refreshed) {
			healthMap.set(listener.sessionId, refreshed);
		}
	}

	// Ensure metadata sessions without listeners still surface empty health rows.
	for (const row of metadata) {
		if (!healthMap.has(row.id)) {
			healthMap.set(row.id, emptySessionHealth(row.id, nowIso));
		}
	}
}

function checkAndPersist(
	controlDbPath: string,
	health: SessionHealthRecord,
	options: SessionDirectoryOptions | undefined,
	now: Date,
): SessionHealthRecord {
	if (!needsSessionCheck(health, health.lastActiveAt, now.getTime())) {
		return health;
	}
	const started = Date.now();
	let alive: boolean | undefined;
	if (health.pid !== null && options?.signalProcess) {
		try {
			options.signalProcess(health.pid, 0);
			alive = true;
		} catch {
			alive = false;
		}
	}
	const next = applyProcessCheck(health, {
		pid: health.pid,
		nowIso: now.toISOString(),
		latencyMs: Date.now() - started,
		alive,
	});
	writeSessionHealth(controlDbPath, next);
	return next;
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
	const metadata = listSessionMetadata(controlDbPath);
	const healthMap = healthBySessionId(controlDbPath);
	ensureHealthSyncedFromListeners(controlDbPath, metadata, healthMap, nowIso);

	if (options.touchCurrentSessionId) {
		const existing =
			healthMap.get(options.touchCurrentSessionId) ?? emptySessionHealth(options.touchCurrentSessionId, nowIso);
		const next = {
			...existing,
			pid: existing.pid ?? process.pid,
			lastActiveAt: nowIso,
			// Current process is known-live for this session.
			lastCheckedAt: nowIso,
			checkStatus: "ok" as const,
			checkedGeneration: existing.agentGeneration > 0 ? existing.agentGeneration : 1,
			agentGeneration: existing.agentGeneration > 0 ? existing.agentGeneration : 1,
			checkLatencyMs: 0,
			updatedAt: nowIso,
		};
		writeSessionHealth(controlDbPath, next);
		healthMap.set(options.touchCurrentSessionId, next);
		if (existing.pid === null || existing.agentGeneration === 0) {
			registerRuntimeMailboxListener(
				controlDbPath,
				{ agentId: null, sessionId: options.touchCurrentSessionId },
				process.pid,
			);
			const refreshed = readSessionHealth(controlDbPath, options.touchCurrentSessionId);
			if (refreshed) healthMap.set(options.touchCurrentSessionId, refreshed);
		}
	}

	const entries: SessionDirectoryEntry[] = [];
	for (const row of metadata) {
		const startingHealth = healthMap.get(row.id) ?? emptySessionHealth(row.id, nowIso);
		const health = checkAndPersist(controlDbPath, startingHealth, options, now);
		healthMap.set(row.id, health);
		const entry = toDirectoryEntry(row, health, now);
		if (!options.includeEnded && entry.status === "ended" && !entry.eligibleToReceive && isStickyDead(health)) {
			// Keep sticky-dead rows visible to callers so skips are inspectable.
			entries.push(entry);
			continue;
		}
		entries.push(entry);
	}
	return entries;
}

function currentMainSessionIds(controlDbPath: string): Set<string> {
	const listeners = listRuntimeMailboxListeners(controlDbPath)
		.filter((listener) => listener.agentId === null)
		.sort((left, right) => {
			const updatedAtOrder = right.updatedAt.localeCompare(left.updatedAt);
			if (updatedAtOrder !== 0) return updatedAtOrder;
			return left.sessionId.localeCompare(right.sessionId);
		});
	const seenPids = new Set<number>();
	const sessionIds = new Set<string>();
	for (const listener of listeners) {
		if (seenPids.has(listener.pid)) continue;
		seenPids.add(listener.pid);
		sessionIds.add(listener.sessionId);
	}
	return sessionIds;
}

function matchesFilters(entry: SessionDirectoryEntry, filters: BroadcastSessionFilters | undefined): boolean {
	if (!filters) return true;
	if (filters.sessionIds && filters.sessionIds.length > 0 && !filters.sessionIds.includes(entry.sessionId)) {
		return false;
	}
	if (filters.cwd && entry.cwd !== filters.cwd) {
		return false;
	}
	if (filters.name && entry.name !== filters.name) {
		return false;
	}
	if (filters.status && filters.status.length > 0 && !filters.status.includes(entry.status)) {
		return false;
	}
	return true;
}

export function broadcastToSessions(
	controlDbPath: string,
	input: BroadcastSessionsInput,
	options: SessionDirectoryOptions = {},
): SessionBroadcastResult[] {
	const message = input.message.trim();
	if (!message) {
		throw new Error("broadcast requires a non-empty message");
	}

	const currentSessionIds = currentMainSessionIds(controlDbPath);
	const seenSessionIds = new Set<string>();
	const entries = listSessions(controlDbPath, options).filter((entry) => {
		if (!currentSessionIds.has(entry.sessionId) || seenSessionIds.has(entry.sessionId)) return false;
		seenSessionIds.add(entry.sessionId);
		return true;
	});
	const results: SessionBroadcastResult[] = [];
	const senderAgentId = input.senderAgentId === undefined ? null : input.senderAgentId;

	for (const entry of entries) {
		if (!matchesFilters(entry, input.filters)) {
			results.push({
				sessionId: entry.sessionId,
				outcome: "skipped_filter",
				checkStatus: entry.checkStatus,
				error: null,
			});
			continue;
		}

		if (
			entry.checkStatus === "dead" ||
			isStickyDead({
				sessionId: entry.sessionId,
				agentGeneration: entry.agentGeneration,
				pid: entry.pid,
				lastActiveAt: entry.lastActiveAt,
				lastCheckedAt: entry.lastCheckedAt,
				checkStatus: entry.checkStatus,
				checkedGeneration: entry.checkedGeneration,
				checkLatencyMs: entry.checkLatencyMs,
				updatedAt: entry.lastCheckedAt ?? entry.startedAt,
			})
		) {
			results.push({
				sessionId: entry.sessionId,
				outcome: "skipped_dead",
				checkStatus: entry.checkStatus,
				error: null,
			});
			continue;
		}

		if (entry.checkStatus === "timeout") {
			results.push({
				sessionId: entry.sessionId,
				outcome: "timeout",
				checkStatus: entry.checkStatus,
				error: "session check timed out",
			});
			continue;
		}

		if (!entry.eligibleToReceive || entry.pid === null) {
			results.push({
				sessionId: entry.sessionId,
				outcome: "check_failed",
				checkStatus: entry.checkStatus,
				error: "session is not eligible to receive messages",
			});
			continue;
		}

		try {
			const messageId = `broadcast_${randomUUID()}`;
			upsertMultiAgentMailboxMessage(controlDbPath, input.senderSessionPath, messageId, {
				body: message,
				fromAgentId: senderAgentId ?? "main",
				id: messageId,
				kind: "message",
				status: "pending",
				toAgentId: "main",
			});
			enqueueRuntimeMailboxMessage(controlDbPath, {
				kind: "message",
				recipient: { agentId: null, sessionId: entry.sessionId },
				sender: { agentId: senderAgentId, sessionId: input.senderSessionId },
				storeRef: { messageId, sessionPath: input.senderSessionPath },
			});
			results.push({
				sessionId: entry.sessionId,
				outcome: "sent",
				checkStatus: entry.checkStatus,
				error: null,
			});
		} catch (error) {
			results.push({
				sessionId: entry.sessionId,
				outcome: "send_failed",
				checkStatus: entry.checkStatus,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return results;
}
