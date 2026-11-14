import type { SqliteDatabase } from "../sqlite.ts";
import { withControlDb } from "./connection.ts";
import { withImmediateTransaction } from "./helpers.ts";

export interface MultiAgentTerminalOutboxRecord {
	sessionPath: string;
	agentId: string;
	terminalRevision: number;
	eventKind: string;
	status: "claimed" | "pending" | "poisoned";
	claimId?: string;
	attemptCount: number;
}

export interface ClaimMultiAgentTerminalOutboxOptions {
	maxAttempts?: number;
	sessionPath?: string;
	staleClaimBefore?: string;
}

export function claimMultiAgentTerminalOutbox(
	controlDbPath: string,
	claimId: string,
	nowIso: string,
	options: ClaimMultiAgentTerminalOutboxOptions = {},
): MultiAgentTerminalOutboxRecord | undefined {
	const maxAttempts = options.maxAttempts ?? 5;
	return withControlDb(controlDbPath, (db) => {
		if (!hasEligibleTerminalOutboxWork(db, maxAttempts, options)) return undefined;
		const row = withImmediateTransaction(db, () => {
			if (options.staleClaimBefore) {
				recoverStaleTerminalOutboxClaims(db, {
					maxAttempts,
					nowIso,
					sessionPath: options.sessionPath,
					staleClaimBefore: options.staleClaimBefore,
				});
			}
			return claimNextTerminalOutboxRow(db, claimId, nowIso, maxAttempts, options.sessionPath);
		});
		return row ? terminalOutboxRecordFromClaimedRow(row, claimId) : undefined;
	});
}

export function hasEligibleTerminalOutboxWork(
	db: SqliteDatabase,
	maxAttempts: number,
	options: ClaimMultiAgentTerminalOutboxOptions,
): boolean {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM multi_agent_terminal_outbox
				 WHERE (? IS NULL OR session_path = ?)
				 AND (
					(status = 'pending' AND attempt_count < ?)
					OR (? IS NOT NULL AND status = 'claimed' AND claimed_at < ?)
				 )
				 LIMIT 1`,
			)
			.get(
				options.sessionPath ?? null,
				options.sessionPath ?? null,
				maxAttempts,
				options.staleClaimBefore ?? null,
				options.staleClaimBefore ?? null,
			),
	);
}

export type RecoverStaleTerminalOutboxClaimsInput = {
	maxAttempts: number;
	nowIso: string;
	sessionPath?: string;
	staleClaimBefore: string;
};

export function recoverStaleTerminalOutboxClaims(
	db: SqliteDatabase,
	input: RecoverStaleTerminalOutboxClaimsInput,
): void {
	db.prepare(
		`UPDATE multi_agent_terminal_outbox
		 SET status = CASE WHEN attempt_count >= ? THEN 'poisoned' ELSE 'pending' END,
		 claim_id = NULL, claimed_at = NULL, last_error = 'claim lease expired', updated_at = ?
		 WHERE status = 'claimed' AND claimed_at < ? AND (? IS NULL OR session_path = ?)`,
	).run(input.maxAttempts, input.nowIso, input.staleClaimBefore, input.sessionPath ?? null, input.sessionPath ?? null);
}

export type ClaimedTerminalOutboxRow = {
	agent_id: string;
	attempt_count: number;
	event_kind: string;
	session_path: string;
	terminal_revision: number;
};

export function claimNextTerminalOutboxRow(
	db: SqliteDatabase,
	claimId: string,
	nowIso: string,
	maxAttempts: number,
	sessionPath?: string,
): ClaimedTerminalOutboxRow | undefined {
	return db
		.prepare(
			`UPDATE multi_agent_terminal_outbox
			 SET status = 'claimed', claim_id = ?, claimed_at = ?,
			 attempt_count = attempt_count + 1, updated_at = ?
			 WHERE rowid = (
				SELECT rowid FROM multi_agent_terminal_outbox
				WHERE status = 'pending' AND attempt_count < ? AND (? IS NULL OR session_path = ?)
				ORDER BY updated_at LIMIT 1
			 )
			 AND status = 'pending'
			 RETURNING session_path, agent_id, terminal_revision, event_kind, attempt_count`,
		)
		.get(claimId, nowIso, nowIso, maxAttempts, sessionPath ?? null, sessionPath ?? null) as
		| ClaimedTerminalOutboxRow
		| undefined;
}

export function terminalOutboxRecordFromClaimedRow(
	row: ClaimedTerminalOutboxRow,
	claimId: string,
): MultiAgentTerminalOutboxRecord {
	return {
		agentId: row.agent_id,
		attemptCount: row.attempt_count,
		claimId,
		eventKind: row.event_kind,
		sessionPath: row.session_path,
		status: "claimed",
		terminalRevision: row.terminal_revision,
	};
}

export function failMultiAgentTerminalOutbox(
	controlDbPath: string,
	record: MultiAgentTerminalOutboxRecord,
	error: string,
	nowIso: string,
	options: { maxAttempts?: number } = {},
): boolean {
	const status = record.attemptCount >= (options.maxAttempts ?? 5) ? "poisoned" : "pending";
	return updateClaimedTerminalOutbox(controlDbPath, record, status, nowIso, error);
}

export function deliverMultiAgentTerminalOutbox(
	controlDbPath: string,
	record: MultiAgentTerminalOutboxRecord,
): boolean {
	return withControlDb(
		controlDbPath,
		(db) =>
			db
				.prepare(
					`DELETE FROM multi_agent_terminal_outbox
				 WHERE session_path = ? AND agent_id = ? AND terminal_revision = ? AND event_kind = ?
				 AND status = 'claimed' AND claim_id = ?`,
				)
				.run(record.sessionPath, record.agentId, record.terminalRevision, record.eventKind, record.claimId ?? null)
				.changes === 1,
	);
}

export function updateClaimedTerminalOutbox(
	controlDbPath: string,
	record: MultiAgentTerminalOutboxRecord,
	status: "pending" | "poisoned",
	nowIso: string,
	error?: string,
): boolean {
	return withControlDb(
		controlDbPath,
		(db) =>
			db
				.prepare(
					`UPDATE multi_agent_terminal_outbox SET status = ?, claim_id = NULL, claimed_at = NULL, last_error = ?, updated_at = ? WHERE session_path = ? AND agent_id = ? AND terminal_revision = ? AND event_kind = ? AND status = 'claimed' AND claim_id = ?`,
				)
				.run(
					status,
					error ?? null,
					nowIso,
					record.sessionPath,
					record.agentId,
					record.terminalRevision,
					record.eventKind,
					record.claimId ?? null,
				).changes === 1,
	);
}

export function cleanupMultiAgentTerminalOutbox(controlDbPath: string, olderThan: string): number {
	return withControlDb(
		controlDbPath,
		(db) =>
			db
				.prepare(
					`DELETE FROM multi_agent_terminal_outbox
					 WHERE status = 'poisoned' AND updated_at < ?`,
				)
				.run(olderThan).changes,
	);
}
