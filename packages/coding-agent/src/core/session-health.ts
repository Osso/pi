export type SessionCheckStatus = "ok" | "dead" | "timeout" | "never";
export type SessionLiveStatus = "running" | "idle" | "ended";

export const SESSION_CHECK_STALE_MS = 5 * 60 * 1000;

export interface SessionHealthRecord {
	sessionId: string;
	agentGeneration: number;
	pid: number | null;
	lastActiveAt: string | null;
	lastCheckedAt: string | null;
	checkStatus: SessionCheckStatus;
	checkedGeneration: number | null;
	checkLatencyMs: number | null;
	updatedAt: string;
}

export interface SessionDirectoryEntry {
	sessionId: string;
	sessionPath: string;
	pid: number | null;
	status: SessionLiveStatus;
	startedAt: string;
	lastActiveAt: string | null;
	name: string | null;
	goal: string | null;
	cwd: string | null;
	lastCheckedAt: string | null;
	checkStatus: SessionCheckStatus;
	checkLatencyMs: number | null;
	agentGeneration: number;
	checkedGeneration: number | null;
	eligibleToReceive: boolean;
}

export interface SessionBroadcastResult {
	sessionId: string;
	outcome: "sent" | "skipped_dead" | "skipped_filter" | "check_failed" | "send_failed" | "timeout";
	checkStatus: SessionCheckStatus;
	error: string | null;
}

export function emptySessionHealth(sessionId: string, nowIso = new Date().toISOString()): SessionHealthRecord {
	return {
		sessionId,
		agentGeneration: 0,
		pid: null,
		lastActiveAt: null,
		lastCheckedAt: null,
		checkStatus: "never",
		checkedGeneration: null,
		checkLatencyMs: null,
		updatedAt: nowIso,
	};
}

export function isStickyDead(health: SessionHealthRecord): boolean {
	return health.checkStatus === "dead" && health.checkedGeneration === health.agentGeneration;
}

export function needsSessionCheck(
	health: SessionHealthRecord,
	lastActiveAt: string | null,
	nowMs = Date.now(),
	staleMs = SESSION_CHECK_STALE_MS,
): boolean {
	if (isStickyDead(health)) {
		return false;
	}
	if (health.checkStatus === "never" || health.checkStatus === "timeout") {
		return true;
	}
	if (health.checkStatus === "ok") {
		const lastActiveMs = lastActiveAt ? Date.parse(lastActiveAt) : Number.NaN;
		const lastCheckedMs = health.lastCheckedAt ? Date.parse(health.lastCheckedAt) : Number.NaN;
		const activeStale = !Number.isFinite(lastActiveMs) || nowMs - lastActiveMs > staleMs;
		const checkedStale = !Number.isFinite(lastCheckedMs) || nowMs - lastCheckedMs > staleMs;
		return activeStale || checkedStale;
	}
	// dead with a newer agent generation (checkedCreation mismatch) needs a check.
	return true;
}

export function isSessionEligibleToReceive(health: SessionHealthRecord): boolean {
	return health.checkStatus === "ok" && !isStickyDead(health);
}

export function deriveLiveStatus(
	health: SessionHealthRecord,
	lastActiveAt: string | null,
	nowMs = Date.now(),
	staleMs = SESSION_CHECK_STALE_MS,
): SessionLiveStatus {
	if (health.checkStatus === "dead" || health.pid === null) {
		return "ended";
	}
	if (health.checkStatus !== "ok") {
		return "ended";
	}
	const lastActiveMs = lastActiveAt ? Date.parse(lastActiveAt) : Number.NaN;
	if (Number.isFinite(lastActiveMs) && nowMs - lastActiveMs <= staleMs) {
		return "running";
	}
	return "idle";
}

export function parseGoalObjective(goalJson: string | undefined | null): string | null {
	if (!goalJson) return null;
	const trimmed = goalJson.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const objective = (parsed as { objective?: unknown }).objective;
			if (typeof objective === "string" && objective.trim()) {
				return objective.trim();
			}
		}
	} catch {
		// Fall through to raw payload for non-JSON goals.
	}
	return trimmed;
}

export function processAlive(
	pid: number,
	signalProcess: (pid: number, signal: 0) => void = defaultSignalProcess,
): boolean {
	try {
		signalProcess(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function defaultSignalProcess(pid: number, signal: 0): void {
	process.kill(pid, signal);
}

export function applyProcessCheck(
	health: SessionHealthRecord,
	options: {
		pid: number | null;
		nowIso?: string;
		latencyMs?: number;
		alive?: boolean;
	},
): SessionHealthRecord {
	const nowIso = options.nowIso ?? new Date().toISOString();
	const latencyMs = options.latencyMs ?? 0;
	if (options.pid === null) {
		return {
			...health,
			pid: null,
			lastCheckedAt: nowIso,
			checkStatus: "dead",
			checkedGeneration: health.agentGeneration,
			checkLatencyMs: latencyMs,
			updatedAt: nowIso,
		};
	}
	const alive = options.alive ?? processAlive(options.pid);
	if (!alive) {
		return {
			...health,
			pid: options.pid,
			lastCheckedAt: nowIso,
			checkStatus: "dead",
			checkedGeneration: health.agentGeneration,
			checkLatencyMs: latencyMs,
			updatedAt: nowIso,
		};
	}
	return {
		...health,
		pid: options.pid,
		lastActiveAt: nowIso,
		lastCheckedAt: nowIso,
		checkStatus: "ok",
		checkedGeneration: health.agentGeneration,
		checkLatencyMs: latencyMs,
		updatedAt: nowIso,
	};
}

export function advanceGenerationForPid(
	health: SessionHealthRecord,
	pid: number,
	nowIso = new Date().toISOString(),
): SessionHealthRecord {
	if (health.pid === pid && health.agentGeneration > 0) {
		return {
			...health,
			pid,
			lastActiveAt: nowIso,
			updatedAt: nowIso,
		};
	}
	return {
		...health,
		pid,
		agentGeneration: health.agentGeneration + 1,
		lastActiveAt: nowIso,
		// New generation invalidates sticky death via checkedGeneration mismatch.
		updatedAt: nowIso,
	};
}
