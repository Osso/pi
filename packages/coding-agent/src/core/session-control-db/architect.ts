import type { SqliteDatabase } from "../sqlite.ts";
import { withControlDb } from "./connection.ts";
import { withImmediateTransaction } from "./helpers.ts";
import type { ArchitectRequest, ArchitectRequestStatus, PostArchitectRequestInput } from "./types.ts";

export function postArchitectRequest(controlDbPath: string, input: PostArchitectRequestInput): number {
	const body = input.body.trim();
	if (!body) {
		throw new Error("Architect request body must be non-empty");
	}
	return withControlDb(controlDbPath, (db) => {
		const now = new Date().toISOString();
		const result = db
			.prepare(
				`
				INSERT INTO architect_requests (sender_session_id, project_cwd, body, status, created_at)
				VALUES (?, ?, ?, 'pending', ?)
				`,
			)
			.run(input.senderSessionId, input.projectCwd, body, now);
		return Number(result.lastInsertRowid);
	});
}

export type ArchitectRequestRow = {
	id: number;
	sender_session_id: string;
	project_cwd: string | null;
	body: string;
	status: ArchitectRequestStatus;
	created_at: string;
	claimed_at: string | null;
	claim_token: string | null;
	completed_at: string | null;
};

export function architectRequestFromRow(row: ArchitectRequestRow): ArchitectRequest {
	return {
		id: row.id,
		senderSessionId: row.sender_session_id,
		projectCwd: row.project_cwd ?? undefined,
		body: row.body,
		status: row.status,
		createdAt: row.created_at,
		claimedAt: row.claimed_at ?? undefined,
		claimToken: row.claim_token ?? undefined,
		completedAt: row.completed_at ?? undefined,
	};
}

export function listPendingArchitectRequests(controlDbPath: string, limit = 20): ArchitectRequest[] {
	return withControlDb(controlDbPath, (db) =>
		(
			db
				.prepare(
					`SELECT id, sender_session_id, project_cwd, body, status, created_at, claimed_at, claim_token, completed_at
					 FROM architect_requests
					 WHERE status = 'pending'
					 ORDER BY id ASC
					 LIMIT ?`,
				)
				.all(Math.max(1, Math.floor(limit))) as ArchitectRequestRow[]
		).map(architectRequestFromRow),
	);
}

export function claimPendingArchitectRequests(
	controlDbPath: string,
	claimToken: string,
	limit = 20,
): ArchitectRequest[] {
	const nowIso = new Date().toISOString();
	const claimLimit = Math.max(1, Math.floor(limit));
	return withControlDb(controlDbPath, (db) => {
		if (!hasArchitectClaimWork(db, nowIso)) return [];
		const rows = withImmediateTransaction(db, () =>
			claimPendingArchitectRequestsInTransaction(db, claimToken, nowIso, claimLimit),
		);
		return rows.map((row) =>
			architectRequestFromRow({ ...row, status: "claimed", claimed_at: nowIso, claim_token: claimToken }),
		);
	});
}

export function claimPendingArchitectRequestsInTransaction(
	db: SqliteDatabase,
	claimToken: string,
	nowIso: string,
	claimLimit: number,
): ArchitectRequestRow[] {
	db.prepare(
		`UPDATE architect_requests
		 SET status = 'pending', claimed_at = NULL, claim_token = NULL
		 WHERE status = 'claimed' AND julianday(claimed_at) < julianday(?, '-2 minutes')`,
	).run(nowIso);
	const rows = db
		.prepare(
			`SELECT id, sender_session_id, project_cwd, body, status, created_at, claimed_at, claim_token, completed_at
			 FROM architect_requests
			 WHERE status = 'pending'
			 ORDER BY id ASC
			 LIMIT ?`,
		)
		.all(claimLimit) as ArchitectRequestRow[];
	const claim = db.prepare(
		`UPDATE architect_requests
		 SET status = 'claimed', claimed_at = ?, claim_token = ?
		 WHERE id = ? AND status = 'pending'`,
	);
	for (const row of rows) claim.run(nowIso, claimToken, row.id);
	return rows;
}

export function hasArchitectClaimWork(db: SqliteDatabase, nowIso: string): boolean {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM architect_requests
				 WHERE status = 'pending'
				 OR (status = 'claimed' AND julianday(claimed_at) < julianday(?, '-2 minutes'))
				 LIMIT 1`,
			)
			.get(nowIso),
	);
}

export function renewArchitectRequestClaims(controlDbPath: string, requestIds: number[], claimToken: string): void {
	const uniqueRequestIds = [...new Set(requestIds)];
	if (uniqueRequestIds.length === 0) return;
	const requestIdsJson = JSON.stringify(uniqueRequestIds);
	const now = new Date().toISOString();
	withControlDb(controlDbPath, (db) =>
		withImmediateTransaction(db, () => {
			db.prepare(
				`UPDATE architect_requests
				 SET claimed_at = ?
				 WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
				 AND status = 'claimed' AND claim_token = ?`,
			).run(now, requestIdsJson, claimToken);
			const lost = db
				.prepare(
					`SELECT CAST(request_ids.value AS INTEGER) AS id
					 FROM json_each(?) AS request_ids
					 LEFT JOIN architect_requests AS requests
					 ON requests.id = CAST(request_ids.value AS INTEGER)
					 WHERE requests.status IS NULL
					 OR (requests.status <> 'completed'
						AND (requests.status <> 'claimed' OR requests.claim_token <> ?))
					 ORDER BY CAST(request_ids.key AS INTEGER)
					 LIMIT 1`,
				)
				.get(requestIdsJson, claimToken) as { id: number } | undefined;
			if (lost) throw new Error(`Architect request claim lost: ${lost.id}`);
		}),
	);
}

export function completeArchitectRequest(
	controlDbPath: string,
	requestId: number,
	claimToken: string,
	senderSessionId?: string,
): void {
	withControlDb(controlDbPath, (db) => {
		db.prepare(
			`UPDATE architect_requests
			 SET status = 'completed', completed_at = ?
			 WHERE id = ? AND status = 'claimed' AND claim_token = ?
			   AND (? IS NULL OR sender_session_id = ?)`,
		).run(new Date().toISOString(), requestId, claimToken, senderSessionId ?? null, senderSessionId ?? null);
	});
}
