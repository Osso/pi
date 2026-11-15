import type { SqliteDatabase } from "../sqlite.ts";
import { parseStoredJsonObject, requireStringField } from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import { withImmediateTransaction } from "./helpers.ts";
import type {
	PostSupervisorRequestInput,
	SupervisorReplyRoute,
	SupervisorRequest,
	SupervisorRequestKind,
	SupervisorRequestStatus,
	SupervisorResponse,
} from "./types.ts";

export type SupervisorRequestRow = {
	id: number;
	sender_session_id: string;
	project_id: string;
	kind: SupervisorRequestKind;
	payload_json: string;
	deadline_at: string;
	status: SupervisorRequestStatus;
	created_at: string;
	claimed_at: string | null;
	claim_token: string | null;
	completed_at: string | null;
	response_json: string | null;
	reply_to_json: string | null;
};

export function parseSupervisorResponse(value: string, requestId: number): SupervisorResponse {
	const context = `supervisor_requests:${requestId}.response_json`;
	const parsed = parseStoredJsonObject(value, context);
	requireStringField(parsed, "kind", context);
	return parsed as SupervisorResponse;
}

export function supervisorRequestFromRow(row: SupervisorRequestRow): SupervisorRequest {
	return {
		id: row.id,
		senderSessionId: row.sender_session_id,
		projectId: row.project_id,
		kind: row.kind,
		payload: parseStoredJsonObject(row.payload_json, `supervisor_requests:${row.id}.payload_json`),
		deadlineAt: row.deadline_at,
		status: row.status,
		createdAt: row.created_at,
		claimedAt: row.claimed_at ?? undefined,
		claimToken: row.claim_token ?? undefined,
		completedAt: row.completed_at ?? undefined,
		response: row.response_json ? parseSupervisorResponse(row.response_json, row.id) : undefined,
		replyTo: row.reply_to_json
			? (parseStoredJsonObject(
					row.reply_to_json,
					`supervisor_requests:${row.id}.reply_to_json`,
				) as unknown as SupervisorReplyRoute)
			: undefined,
	};
}

export const SUPERVISOR_REQUEST_COLUMNS = `id, sender_session_id, project_id, kind, payload_json, deadline_at,
	status, created_at, claimed_at, claim_token, completed_at, response_json, reply_to_json`;

export function postSupervisorRequest(controlDbPath: string, input: PostSupervisorRequestInput): number {
	return withControlDb(controlDbPath, (db) => {
		const result = db
			.prepare(
				`INSERT INTO supervisor_requests
				 (sender_session_id, project_id, kind, payload_json, deadline_at, status, created_at, reply_to_json)
				 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
			)
			.run(
				input.senderSessionId,
				input.projectId,
				input.kind,
				JSON.stringify(input.payload),
				input.deadlineAt,
				new Date().toISOString(),
				input.replyTo ? JSON.stringify(input.replyTo) : null,
			);
		return Number(result.lastInsertRowid);
	});
}

export function readSupervisorRequest(controlDbPath: string, requestId: number): SupervisorRequest | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(`SELECT ${SUPERVISOR_REQUEST_COLUMNS} FROM supervisor_requests WHERE id = ?`)
			.get(requestId) as SupervisorRequestRow | undefined;
		return row ? supervisorRequestFromRow(row) : undefined;
	});
}

/** Cancels the pending or claimed request that replies to `route`; true when one was cancelled. */
export function cancelSupervisorRequest(controlDbPath: string, route: SupervisorReplyRoute, reason: string): boolean {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const response: SupervisorResponse = { kind: "error", reason };
			const result = db
				.prepare(
					`UPDATE supervisor_requests
					 SET status = 'cancelled', completed_at = ?, claim_token = NULL, response_json = ?
					 WHERE sender_session_id = ? AND json_extract(reply_to_json, '$.requestId') = ?
					   AND (status IN ('pending', 'claimed') OR (kind = 'question' AND status = 'completed'))`,
				)
				.run(new Date().toISOString(), JSON.stringify(response), route.sessionId, route.requestId);
			return result.changes === 1;
		}),
	);
}

export function claimNextSupervisorRequest(controlDbPath: string, claimToken: string): SupervisorRequest | undefined {
	return withControlDb(controlDbPath, (db) => {
		if (!readNextSupervisorRequestToClaim(db)) return undefined;
		const claimedAt = new Date().toISOString();
		const row = withImmediateTransaction(db, () =>
			claimNextSupervisorRequestInTransaction(db, claimToken, claimedAt),
		);
		return row ? supervisorRequestFromRow(row) : undefined;
	});
}

export function claimNextSupervisorRequestInTransaction(
	db: SqliteDatabase,
	claimToken: string,
	claimedAt: string,
): SupervisorRequestRow | undefined {
	const row = readNextSupervisorRequestToClaim(db);
	if (!row) return undefined;
	return db
		.prepare(
			`UPDATE supervisor_requests
			 SET status = 'claimed', claimed_at = ?, claim_token = ?
			 WHERE id = ? AND status = 'pending'
			 RETURNING ${SUPERVISOR_REQUEST_COLUMNS}`,
		)
		.get(claimedAt, claimToken, row.id) as SupervisorRequestRow | undefined;
}

export function readNextSupervisorRequestToClaim(db: SqliteDatabase): SupervisorRequestRow | undefined {
	const activeClaim = db.prepare("SELECT 1 FROM supervisor_requests WHERE status = 'claimed' LIMIT 1").get();
	if (activeClaim) return undefined;
	return db
		.prepare(
			`SELECT ${SUPERVISOR_REQUEST_COLUMNS}
			 FROM supervisor_requests
			 WHERE status = 'pending'
			 ORDER BY CASE kind
				 WHEN 'approval_review' THEN 0
				 WHEN 'supervisor_advisory' THEN 2
				 WHEN 'question' THEN 3
				 ELSE 1
			 END, id ASC
			 LIMIT 1`,
		)
		.get() as SupervisorRequestRow | undefined;
}

export function recoverSupervisorRequests(controlDbPath: string): void {
	const nowIso = new Date().toISOString();
	withControlDb(controlDbPath, (db) => {
		if (!hasSupervisorRecoveryWork(db, nowIso)) return;
		const errorResponse = JSON.stringify({ kind: "error", reason: "Supervisor request deadline expired" });
		withImmediateTransaction(db, () => {
			db.prepare(
				`UPDATE supervisor_requests
				 SET status = 'completed', completed_at = ?, response_json = ?, claim_token = NULL
				 WHERE status IN ('pending', 'claimed') AND deadline_at <= ?`,
			).run(nowIso, errorResponse, nowIso);
			db.prepare(
				`UPDATE supervisor_requests
				 SET status = 'pending', claimed_at = NULL, claim_token = NULL
				 WHERE status = 'claimed'`,
			).run();
		});
	});
}

export function hasSupervisorRecoveryWork(db: SqliteDatabase, nowIso: string): boolean {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM supervisor_requests
				 WHERE status = 'claimed' OR (status = 'pending' AND deadline_at <= ?)
				 LIMIT 1`,
			)
			.get(nowIso),
	);
}

export function hasPendingSupervisorApprovalRequest(controlDbPath: string): boolean {
	return withControlDb(controlDbPath, (db) =>
		Boolean(
			db
				.prepare("SELECT 1 FROM supervisor_requests WHERE status = 'pending' AND kind = 'approval_review' LIMIT 1")
				.get(),
		),
	);
}

export function requeueSupervisorRequest(controlDbPath: string, requestId: number, claimToken: string): void {
	withControlDb(controlDbPath, (db) => {
		const result = db
			.prepare(
				`UPDATE supervisor_requests
				 SET status = 'pending', claimed_at = NULL, claim_token = NULL
				 WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
			)
			.run(requestId, claimToken);
		if (result.changes !== 1) throw new Error(`Supervisor request claim lost: ${requestId}`);
	});
}

export function isSupervisorResponseValidForRequest(
	requestKind: SupervisorRequestKind,
	responseKind: SupervisorResponse["kind"],
): boolean {
	if (responseKind === "error") return true;
	if (requestKind === "approval_review") return responseKind === "approve" || responseKind === "reject";
	if (requestKind === "goal_set_review") return responseKind === "set";
	if (requestKind === "supervisor_advisory") return responseKind === "advisory";
	if (requestKind === "question") return responseKind === "answer" || responseKind === "escalate";
	return (
		responseKind === "complete" || responseKind === "continue" || responseKind === "pause" || responseKind === "wait"
	);
}

export function completeSupervisorRequest(
	controlDbPath: string,
	requestId: number,
	claimToken: string,
	response: SupervisorResponse,
): void {
	withControlDb(controlDbPath, (db) => {
		const request = db
			.prepare("SELECT kind FROM supervisor_requests WHERE id = ? AND status = 'claimed' AND claim_token = ?")
			.get(requestId, claimToken) as { kind: SupervisorRequestKind } | undefined;
		if (!request) throw new Error(`Supervisor request claim lost: ${requestId}`);
		if (!isSupervisorResponseValidForRequest(request.kind, response.kind)) {
			throw new Error(`Invalid Supervisor response kind ${response.kind} for ${request.kind}`);
		}
		const result = db
			.prepare(
				`UPDATE supervisor_requests
				 SET status = 'completed', completed_at = ?, response_json = ?
				 WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
			)
			.run(new Date().toISOString(), JSON.stringify(response), requestId, claimToken);
		if (result.changes !== 1) throw new Error(`Supervisor request claim lost: ${requestId}`);
	});
}
