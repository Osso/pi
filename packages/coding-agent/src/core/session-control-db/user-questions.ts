import { withControlDb } from "./connection.ts";

export interface UserQuestion {
	id: number;
	targetHost: string | null;
	targetSessionId: string;
	question: string;
	status: "open" | "answered";
	answer: string | null;
	createdAt: string;
	answeredAt: string | null;
	parentId: number | null;
}

interface UserQuestionRow {
	id: number;
	target_host: string | null;
	target_session_id: string;
	question: string;
	status: "open" | "answered";
	answer: string | null;
	created_at: string;
	answered_at: string | null;
	parent_id: number | null;
}

function fromRow(row: UserQuestionRow): UserQuestion {
	return {
		id: row.id,
		targetHost: row.target_host,
		targetSessionId: row.target_session_id,
		question: row.question,
		status: row.status,
		answer: row.answer,
		createdAt: row.created_at,
		answeredAt: row.answered_at,
		parentId: row.parent_id,
	};
}

export function postUserQuestion(
	controlDbPath: string,
	input: {
		targetHost?: string;
		targetSessionId: string;
		question: string;
		parentId?: number;
	},
): number {
	return withControlDb(controlDbPath, (db) => {
		const createdAt = new Date().toISOString();
		const result = db
			.prepare(`INSERT INTO user_questions
			(target_host, target_session_id, question, status, answer, created_at, answered_at, parent_id)
			VALUES (?, ?, ?, 'open', NULL, ?, NULL, ?)`)
			.run(input.targetHost ?? null, input.targetSessionId, input.question, createdAt, input.parentId ?? null);
		return Number(result.lastInsertRowid);
	});
}

export function recordUserQuestionAnswer(controlDbPath: string, id: number, answer: string): boolean {
	return withControlDb(
		controlDbPath,
		(db) =>
			db
				.prepare("UPDATE user_questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?")
				.run(answer, new Date().toISOString(), id).changes === 1,
	);
}

export function listUserQuestions(controlDbPath: string): UserQuestion[] {
	return withControlDb(controlDbPath, (db) =>
		(db.prepare("SELECT * FROM user_questions ORDER BY created_at DESC, id DESC").all() as UserQuestionRow[]).map(
			fromRow,
		),
	);
}

export function readUserQuestion(controlDbPath: string, id: number): UserQuestion | undefined {
	return withControlDb(controlDbPath, (db) => {
		const row = db.prepare("SELECT * FROM user_questions WHERE id = ?").get(id) as UserQuestionRow | undefined;
		return row ? fromRow(row) : undefined;
	});
}
