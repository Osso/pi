import { isPiRuntimeProcessAlive, isProcessIdentityAlive } from "../runtime-process.ts";
import {
	emptySessionHealth,
	endSessionHealth,
	type SessionCheckStatus,
	type SessionHealthRecord,
} from "../session-health.ts";
import type { SqliteDatabase } from "../sqlite.ts";
import { withControlDb } from "./connection.ts";
import { parseProcessIdentity, withImmediateTransaction } from "./helpers.ts";
import {
	RUNTIME_PROCESS_INSTANCE_ID,
	readRuntimeMailboxListenerRow,
	recoverDeadRuntimeMailboxClaims,
	runtimeMailboxListenerRowsEqual,
} from "./runtime-mailbox-enqueue.ts";
import { runtimeMailboxAgentIdKey } from "./shared-channel.ts";
import type { RuntimeMailboxAddress, RuntimeMailboxListenerRow, RuntimeMailboxRegistrationOptions } from "./types.ts";

export const UPSERT_RUNTIME_MAILBOX_LISTENER_SQL = `
	INSERT INTO runtime_mailbox_listeners (
		recipient_session_id,
		recipient_agent_id_key,
		pid,
		runtime_instance_id,
		session_path,
		session_path_asserted_at,
		updated_at
	)
	VALUES (?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(recipient_session_id, recipient_agent_id_key) DO UPDATE SET
		pid = excluded.pid,
		runtime_instance_id = excluded.runtime_instance_id,
		session_path = excluded.session_path,
		session_path_asserted_at = excluded.session_path_asserted_at,
		updated_at = excluded.updated_at
`;

export type SessionHealthRow = {
	session_id: string;
	agent_generation: number;
	pid: number | null;
	last_active_at: string | null;
	last_checked_at: string | null;
	check_status: string;
	checked_generation: number | null;
	check_latency_ms: number | null;
	updated_at: string;
};

export const RUNTIME_MAILBOX_REGISTRATION_MAX_ATTEMPTS = 3;

export type RuntimeMailboxRegistration = {
	options: RuntimeMailboxRegistrationOptions;
	pid: number;
	recipient: RuntimeMailboxAddress;
	runtimeInstanceId: string;
	sessionPath: string | undefined;
};

export type RuntimeMailboxRegistrationSnapshot = {
	health: SessionHealthRecord | undefined;
	listener: RuntimeMailboxListenerRow | undefined;
};

export type RuntimeMailboxRegistrationPlan = {
	nowIso: string;
	shouldReconcileReplacement: boolean;
	snapshot: RuntimeMailboxRegistrationSnapshot;
};

export function registerTemporaryRuntimeMailboxWaiter(controlDbPath: string, sessionId: string): () => void {
	const recipient = { sessionId, agentId: null };
	const pid = process.pid;
	const runtimeInstanceId = RUNTIME_PROCESS_INSTANCE_ID;
	withControlDb(controlDbPath, (db) => {
		if (readRuntimeMailboxListenerRow(db, recipient)) {
			throw new Error(`Temporary mailbox route already exists for ${sessionId}`);
		}
		upsertRuntimeMailboxListenerRow(db, recipient, pid, undefined, runtimeInstanceId, new Date().toISOString());
	});
	return () => {
		withControlDb(controlDbPath, (db) => {
			db.prepare(
				"DELETE FROM runtime_mailbox_listeners WHERE recipient_session_id = ? AND recipient_agent_id_key = '' AND pid = ? AND runtime_instance_id = ?",
			).run(sessionId, pid, runtimeInstanceId);
		});
	};
}

export function registerRuntimeMailboxListener(
	controlDbPath: string,
	recipient: RuntimeMailboxAddress,
	pid: number,
	sessionPath?: string,
	options: RuntimeMailboxRegistrationOptions = {},
): void {
	const registration: RuntimeMailboxRegistration = {
		options,
		pid,
		recipient,
		runtimeInstanceId: options.runtimeInstanceId ?? RUNTIME_PROCESS_INSTANCE_ID,
		sessionPath,
	};
	withControlDb(controlDbPath, (db) => registerRuntimeMailboxListenerWithDb(db, registration));
	const ownsRegistration = pid === process.pid && registration.runtimeInstanceId === RUNTIME_PROCESS_INSTANCE_ID;
	if (ownsRegistration && options.isMailboxStoreRefAccepted) {
		recoverDeadRuntimeMailboxClaims(controlDbPath, recipient, options.isMailboxStoreRefAccepted);
	}
}

export function registerRuntimeMailboxListenerWithDb(
	db: SqliteDatabase,
	registration: RuntimeMailboxRegistration,
): void {
	for (let attempt = 1; attempt <= RUNTIME_MAILBOX_REGISTRATION_MAX_ATTEMPTS; attempt += 1) {
		const plan = prepareRuntimeMailboxRegistration(db, registration);
		if (commitRuntimeMailboxRegistration(db, registration, plan)) return;
	}
	throw new Error(
		`Runtime mailbox listener changed repeatedly while registering session ${registration.recipient.sessionId}`,
	);
}

export function prepareRuntimeMailboxRegistration(
	db: SqliteDatabase,
	registration: RuntimeMailboxRegistration,
): RuntimeMailboxRegistrationPlan {
	const snapshot = readRuntimeMailboxRegistrationSnapshot(db, registration.recipient);
	const runtimeOwnerChanged =
		snapshot.listener?.pid !== registration.pid ||
		snapshot.listener?.runtime_instance_id !== registration.runtimeInstanceId;
	const shouldReconcileReplacement =
		registration.recipient.agentId === null &&
		registration.options.reconcileRuntimeReplacement !== false &&
		runtimeOwnerChanged;
	if (shouldReconcileReplacement) assertRuntimeReplacementAllowed(db, registration, snapshot);
	return { nowIso: new Date().toISOString(), shouldReconcileReplacement, snapshot };
}

export function commitRuntimeMailboxRegistration(
	db: SqliteDatabase,
	registration: RuntimeMailboxRegistration,
	plan: RuntimeMailboxRegistrationPlan,
): boolean {
	return withImmediateTransaction(db, () => {
		const current = readRuntimeMailboxRegistrationSnapshot(db, registration.recipient);
		if (!runtimeMailboxRegistrationSnapshotsEqual(plan.snapshot, current)) return false;
		registerRuntimeMailboxListenerInTransaction(db, registration, plan.nowIso, plan.shouldReconcileReplacement);
		return true;
	});
}

export function readRuntimeMailboxRegistrationSnapshot(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
): RuntimeMailboxRegistrationSnapshot {
	return {
		health: recipient.agentId === null ? readSessionHealthRow(db, recipient.sessionId) : undefined,
		listener: readRuntimeMailboxListenerRow(db, recipient),
	};
}

export function runtimeMailboxRegistrationSnapshotsEqual(
	expected: RuntimeMailboxRegistrationSnapshot,
	current: RuntimeMailboxRegistrationSnapshot,
): boolean {
	return (
		runtimeMailboxListenerRowsEqual(expected.listener, current.listener) &&
		sessionHealthRowsEqual(expected.health, current.health)
	);
}

export function sessionHealthRowsEqual(
	expected: SessionHealthRecord | undefined,
	current: SessionHealthRecord | undefined,
): boolean {
	if (!expected || !current) return expected === current;
	return (
		expected.sessionId === current.sessionId &&
		expected.agentGeneration === current.agentGeneration &&
		expected.pid === current.pid &&
		expected.lastActiveAt === current.lastActiveAt &&
		expected.lastCheckedAt === current.lastCheckedAt &&
		expected.checkStatus === current.checkStatus &&
		expected.checkedGeneration === current.checkedGeneration &&
		expected.checkLatencyMs === current.checkLatencyMs &&
		expected.updatedAt === current.updatedAt
	);
}

export function registerRuntimeMailboxListenerInTransaction(
	db: SqliteDatabase,
	registration: RuntimeMailboxRegistration,
	nowIso: string,
	shouldReconcileReplacement: boolean,
): void {
	const { pid, recipient, runtimeInstanceId, sessionPath } = registration;
	if (recipient.agentId === null) {
		retireSupersededMainRuntimeMailboxListeners(db, recipient.sessionId, pid, nowIso);
	}
	upsertRuntimeMailboxListenerRow(db, recipient, pid, sessionPath, runtimeInstanceId, nowIso);
	if (recipient.agentId === null) {
		upsertSessionHealthForListener(db, recipient.sessionId, pid, nowIso, shouldReconcileReplacement);
	}
}

/** The session is live in another Pi process; nothing was torn down, so callers can stay on their current session. */
export class SessionOpenElsewhereError extends Error {}

export function assertRuntimeReplacementAllowed(
	db: SqliteDatabase,
	registration: RuntimeMailboxRegistration,
	snapshot: RuntimeMailboxRegistrationSnapshot,
): void {
	const existingListener = snapshot.listener;
	const existingOwnerPid = existingListener?.pid ?? snapshot.health?.pid;
	if (existingOwnerPid === null || existingOwnerPid === undefined) return;
	if (existingListener?.runtime_instance_id === registration.runtimeInstanceId) return;
	if (existingListener?.runtime_instance_id) {
		try {
			if (!isProcessIdentityAlive(parseProcessIdentity(existingListener.runtime_instance_id))) return;
		} catch {
			if (existingOwnerPid === registration.pid) return;
		}
	}
	const isRuntimeProcessAlive = registration.options.isRuntimeProcessAlive ?? isPiRuntimeProcessAlive;
	if (!isRuntimeProcessAlive(existingOwnerPid)) return;
	const sessionId = registration.recipient.sessionId;
	const cwd = existingListener ? readVerifiedSessionCwd(db, sessionId, existingListener) : undefined;
	const processContext = cwd ? `PID ${existingOwnerPid}, cwd ${cwd}` : `PID ${existingOwnerPid}`;
	throw new SessionOpenElsewhereError(
		`Cannot continue session ${sessionId} because it is open in another Pi process (${processContext}). Close that Pi session, run pi to start a new session, or use pi -r to choose another.`,
	);
}

export function readVerifiedSessionCwd(
	db: SqliteDatabase,
	sessionId: string,
	listener: RuntimeMailboxListenerRow,
): string | undefined {
	const sessionPath = trustedRuntimeMailboxSessionPath(listener);
	if (!sessionPath) return undefined;
	const row = db
		.prepare("SELECT cwd FROM session_metadata WHERE session_path = ? AND id = ?")
		.get(sessionPath, sessionId) as { cwd: string } | undefined;
	return row?.cwd;
}

export function upsertRuntimeMailboxListenerRow(
	db: SqliteDatabase,
	recipient: RuntimeMailboxAddress,
	pid: number,
	sessionPath: string | undefined,
	runtimeInstanceId: string,
	nowIso: string,
): void {
	db.prepare(UPSERT_RUNTIME_MAILBOX_LISTENER_SQL).run(
		recipient.sessionId,
		runtimeMailboxAgentIdKey(recipient.agentId),
		pid,
		runtimeInstanceId,
		sessionPath ?? null,
		sessionPath ? nowIso : null,
		nowIso,
	);
}

export function retireSupersededMainRuntimeMailboxListeners(
	db: SqliteDatabase,
	currentSessionId: string,
	pid: number,
	nowIso: string,
): void {
	const supersededListeners = db
		.prepare(
			`
			DELETE FROM runtime_mailbox_listeners
			WHERE recipient_agent_id_key = ''
				AND pid = ?
				AND recipient_session_id <> ?
			RETURNING recipient_session_id
			`,
		)
		.all(pid, currentSessionId) as Array<{ recipient_session_id: string }>;
	for (const listener of supersededListeners) {
		retireSessionHealthForListener(db, listener.recipient_session_id, pid, nowIso);
	}
}

export function retireSessionHealthForListener(
	db: SqliteDatabase,
	sessionId: string,
	pid: number,
	nowIso: string,
): void {
	const existing = readSessionHealthRow(db, sessionId);
	if (!existing || existing.pid !== pid) return;
	writeSessionHealthRow(db, endSessionHealth(existing, nowIso));
}

export function trustedRuntimeMailboxSessionPath(
	row: Pick<RuntimeMailboxListenerRow, "session_path" | "session_path_asserted_at" | "updated_at">,
): string | undefined {
	return row.session_path !== null && row.session_path_asserted_at === row.updated_at ? row.session_path : undefined;
}

export function writeSessionHealthRow(db: SqliteDatabase, health: SessionHealthRecord): void {
	db.prepare(
		`
		INSERT INTO session_health (
			session_id,
			agent_generation,
			pid,
			last_active_at,
			last_checked_at,
			check_status,
			checked_generation,
			check_latency_ms,
			updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
			agent_generation = excluded.agent_generation,
			pid = excluded.pid,
			last_active_at = excluded.last_active_at,
			last_checked_at = excluded.last_checked_at,
			check_status = excluded.check_status,
			checked_generation = excluded.checked_generation,
			check_latency_ms = excluded.check_latency_ms,
			updated_at = excluded.updated_at
		`,
	).run(
		health.sessionId,
		health.agentGeneration,
		health.pid,
		health.lastActiveAt,
		health.lastCheckedAt,
		health.checkStatus,
		health.checkedGeneration,
		health.checkLatencyMs,
		health.updatedAt,
	);
}

export function readSessionHealthRow(db: SqliteDatabase, sessionId: string): SessionHealthRecord | undefined {
	const row = db
		.prepare(
			`
			SELECT
				session_id,
				agent_generation,
				pid,
				last_active_at,
				last_checked_at,
				check_status,
				checked_generation,
				check_latency_ms,
				updated_at
			FROM session_health
			WHERE session_id = ?
			`,
		)
		.get(sessionId) as SessionHealthRow | undefined;
	return row ? sessionHealthFromRow(row) : undefined;
}

export function upsertSessionHealthForListener(
	db: SqliteDatabase,
	sessionId: string,
	pid: number,
	nowIso: string,
	forceNewGeneration: boolean,
): void {
	const existing = readSessionHealthRow(db, sessionId) ?? emptySessionHealth(sessionId, nowIso);
	const sameGeneration = !forceNewGeneration && existing.pid === pid && existing.agentGeneration > 0;
	const agentGeneration = sameGeneration ? existing.agentGeneration : existing.agentGeneration + 1;
	writeSessionHealthRow(db, {
		...existing,
		pid,
		agentGeneration,
		lastActiveAt: nowIso,
		lastCheckedAt: nowIso,
		checkStatus: "ok",
		checkedGeneration: agentGeneration,
		checkLatencyMs: 0,
		updatedAt: nowIso,
	});
}

export function sessionHealthFromRow(row: SessionHealthRow): SessionHealthRecord {
	return {
		sessionId: row.session_id,
		agentGeneration: row.agent_generation,
		pid: row.pid,
		lastActiveAt: row.last_active_at,
		lastCheckedAt: row.last_checked_at,
		checkStatus: toSessionCheckStatus(row.check_status),
		checkedGeneration: row.checked_generation,
		checkLatencyMs: row.check_latency_ms,
		updatedAt: row.updated_at,
	};
}

export function toSessionCheckStatus(value: string): SessionCheckStatus {
	if (value === "ok" || value === "dead" || value === "timeout" || value === "never") {
		return value;
	}
	return "never";
}
