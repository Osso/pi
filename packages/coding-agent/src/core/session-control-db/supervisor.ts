import type { SqliteDatabase } from "../sqlite.ts";
import { parseStoredJsonObject, requireStringField } from "./codecs.ts";
import { withControlDb } from "./connection.ts";
import { withImmediateTransaction } from "./helpers.ts";
import {
	type PostSupervisorRequestInput,
	QUESTION_RETENTION_MS,
	type SupervisorQuestionAnswer,
	type SupervisorReplyRoute,
	type SupervisorRequest,
	type SupervisorRequestKind,
	type SupervisorRequestStatus,
	type SupervisorResponse,
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

/**
 * Cancels the pending, claimed, or escalated request that replies to `route`; true when one was cancelled.
 * `localAnswers` are the answers the asker gave in its own panel; they stay in the row as a `local` answer.
 */
export function cancelSupervisorRequest(
	controlDbPath: string,
	route: SupervisorReplyRoute,
	reason: string,
	localAnswers?: Record<string, string>,
): boolean {
	return withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			const response: SupervisorResponse = localAnswers
				? { kind: "answer", answers: toStoredAnswers(localAnswers), answeredBy: "local" }
				: { kind: "error", reason };
			const result = db
				.prepare(
					`UPDATE supervisor_requests
					 SET status = 'cancelled', completed_at = ?, claim_token = NULL, response_json = ?
					 WHERE sender_session_id = ? AND json_extract(reply_to_json, '$.requestId') = ?
					   AND status IN ('pending', 'claimed', 'escalated')`,
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
		// A question the Supervisor did not answer waits for the user; it is not finished yet.
		const escalated = request.kind === "question" && response.kind !== "answer";
		const result = db
			.prepare(
				`UPDATE supervisor_requests
				 SET status = ?, completed_at = ?, response_json = ?
				 WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
			)
			.run(
				escalated ? "escalated" : "completed",
				escalated ? null : new Date().toISOString(),
				JSON.stringify(response),
				requestId,
				claimToken,
			);
		if (result.changes !== 1) throw new Error(`Supervisor request claim lost: ${requestId}`);
	});
}

function toStoredAnswers(answers: Record<string, string>): Record<string, SupervisorQuestionAnswer> {
	return Object.fromEntries(Object.entries(answers).map(([question, answer]) => [question, { answer, reason: "" }]));
}

/** Question rows of the last three days, newest first. */
export function listQuestionRequests(controlDbPath: string): SupervisorRequest[] {
	const cutoff = new Date(Date.now() - QUESTION_RETENTION_MS).toISOString();
	return withControlDb(controlDbPath, (db) =>
		(
			db
				.prepare(
					`SELECT ${SUPERVISOR_REQUEST_COLUMNS} FROM supervisor_requests
					 WHERE kind = 'question' AND created_at > ? ORDER BY id DESC`,
				)
				.all(cutoff) as SupervisorRequestRow[]
		).map(supervisorRequestFromRow),
	);
}

/**
 * Stores the user's answer to an escalated question. Returns the answered request, or undefined when the
 * question is no longer escalated (already answered, withdrawn, or expired): the first answer wins.
 */
export function answerEscalatedQuestion(
	controlDbPath: string,
	requestId: number,
	answers: Record<string, string>,
): SupervisorRequest | undefined {
	const response: SupervisorResponse = { kind: "answer", answers: toStoredAnswers(answers), answeredBy: "user" };
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`UPDATE supervisor_requests SET status = 'completed', completed_at = ?, response_json = ?
				 WHERE id = ? AND kind = 'question' AND status = 'escalated'
				 RETURNING ${SUPERVISOR_REQUEST_COLUMNS}`,
			)
			.get(new Date().toISOString(), JSON.stringify(response), requestId) as SupervisorRequestRow | undefined;
		return row ? supervisorRequestFromRow(row) : undefined;
	});
}

/**
 * Replaces the stored answer of an answered question with the user's revision. Returns the revised
 * request, or undefined when the question has no answer to revise.
 */
export function reviseQuestionAnswer(
	controlDbPath: string,
	requestId: number,
	answers: Record<string, string>,
): SupervisorRequest | undefined {
	const revisedAt = new Date().toISOString();
	const response: SupervisorResponse = {
		kind: "answer",
		answers: toStoredAnswers(answers),
		answeredBy: "user",
		revisedAt,
	};
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(
				`UPDATE supervisor_requests SET response_json = ?
				 WHERE id = ? AND kind = 'question'
				   AND (status = 'cancelled' OR json_extract(response_json, '$.kind') = 'answer')
				 RETURNING ${SUPERVISOR_REQUEST_COLUMNS}`,
			)
			.get(JSON.stringify(response), requestId) as SupervisorRequestRow | undefined;
		return row ? supervisorRequestFromRow(row) : undefined;
	});
}
