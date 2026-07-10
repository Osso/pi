import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	abortInactiveSessionSpawnedAgents,
	enqueueRuntimeMailboxMessage,
	listRuntimeMailboxListeners,
	listSessionHealth,
	listSessionMetadata,
	registerRuntimeMailboxListener,
	retireRuntimeMailboxListener,
	type SessionMetadata,
	upsertMultiAgentMailboxMessage,
	writeSessionHealth,
} from "./session-control-db.ts";
import {
	deriveLiveStatus,
	emptySessionHealth,
	endSessionHealth,
	isSessionEligibleToReceive,
	isStickyDead,
	parseGoalObjective,
	SESSION_CHECK_STALE_MS,
	type SessionBroadcastResult,
	type SessionDirectoryEntry,
	type SessionHealthRecord,
} from "./session-health.ts";

export interface SessionDirectoryOptions {
	now?: () => Date;
	includeEnded?: boolean;
	isRuntimeProcessAlive?: (pid: number) => boolean;
	touchCurrentSessionId?: string;
	touchCurrentSessionPath?: string;
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

interface CurrentMainSessionBinding {
	pid: number;
	updatedAt: string;
	heartbeatFresh: boolean;
}

const PI_RUNTIME_ENTRYPOINT_SUFFIXES = [
	"packages/coding-agent/src/cli.ts",
	"packages/coding-agent/src/bun/cli.ts",
	"packages/coding-agent/dist/cli.js",
];

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
		const processUnavailable = !heartbeatFresh && !isRuntimeProcessAlive(listener.pid);
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

function defaultIsRuntimeProcessAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EPERM")) return false;
	}
	const commandLine = tryReadProcessCommandLine(pid);
	return commandLine === undefined || commandLineIsPiRuntime(commandLine);
}

function tryReadProcessCommandLine(pid: number): string[] | undefined {
	try {
		if (process.platform === "linux") {
			return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
		}
		if (process.platform !== "win32") {
			const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
				encoding: "utf8",
				timeout: 1000,
			}).trim();
			return command ? command.split(/\s+/) : undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function commandLineIsPiRuntime(commandLine: string[]): boolean {
	const executable = commandLine[0];
	if (!executable) return false;
	const executableName = basename(executable).toLowerCase();
	if (executableName === "pi" || executableName === "pi.exe") return true;
	return commandLine.slice(1).some((argument) => {
		const normalized = argument.replaceAll("\\", "/");
		return PI_RUNTIME_ENTRYPOINT_SUFFIXES.some(
			(suffix) => normalized === suffix || normalized.endsWith(`/${suffix}`),
		);
	});
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

function registerTouchedSessionBinding(
	controlDbPath: string,
	sessionId: string | undefined,
	sessionPath: string | undefined,
): void {
	if (!sessionId) return;
	registerRuntimeMailboxListener(controlDbPath, { agentId: null, sessionId }, process.pid, sessionPath, {
		reconcileRuntimeReplacement: false,
	});
}

function markTouchedSessionActive(
	controlDbPath: string,
	sessionId: string | undefined,
	healthMap: Map<string, SessionHealthRecord>,
	nowIso: string,
): void {
	if (!sessionId) return;
	const existing = healthMap.get(sessionId) ?? emptySessionHealth(sessionId, nowIso);
	const next = {
		...existing,
		pid: process.pid,
		lastActiveAt: nowIso,
		lastCheckedAt: nowIso,
		checkStatus: "ok" as const,
		checkedGeneration: existing.agentGeneration,
		checkLatencyMs: 0,
		updatedAt: nowIso,
	};
	writeSessionHealth(controlDbPath, next);
	healthMap.set(sessionId, next);
}

export function listSessions(controlDbPath: string, options: SessionDirectoryOptions = {}): SessionDirectoryEntry[] {
	const now = resolveNow(options);
	const nowIso = now.toISOString();
	registerTouchedSessionBinding(controlDbPath, options.touchCurrentSessionId, options.touchCurrentSessionPath);
	const metadata = newestMetadataBySessionId(listSessionMetadata(controlDbPath));
	const healthMap = healthBySessionId(controlDbPath);
	const isRuntimeProcessAlive = options.isRuntimeProcessAlive ?? defaultIsRuntimeProcessAlive;
	const bindings = reconcileCurrentMainSessionBindings(controlDbPath, now, isRuntimeProcessAlive);
	ensureHealthSyncedFromListeners(controlDbPath, metadata, healthMap, bindings, now);
	abortInactiveSessionSpawnedAgents(controlDbPath);
	markTouchedSessionActive(controlDbPath, options.touchCurrentSessionId, healthMap, nowIso);
	return metadata
		.map((row) => toDirectoryEntry(row, healthMap.get(row.id) ?? emptySessionHealth(row.id, nowIso), now))
		.filter((entry) => options.includeEnded !== false || entry.status !== "ended");
}

function currentMainSessionIds(
	controlDbPath: string,
	now: Date,
	isRuntimeProcessAlive: (pid: number) => boolean,
): Set<string> {
	return new Set(reconcileCurrentMainSessionBindings(controlDbPath, now, isRuntimeProcessAlive).keys());
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

	const now = resolveNow(options);
	const stableOptions = { ...options, now: () => now };
	const isRuntimeProcessAlive = options.isRuntimeProcessAlive ?? defaultIsRuntimeProcessAlive;
	const currentSessionIds = currentMainSessionIds(controlDbPath, now, isRuntimeProcessAlive);
	const seenSessionIds = new Set<string>();
	const entries = listSessions(controlDbPath, stableOptions).filter((entry) => {
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
