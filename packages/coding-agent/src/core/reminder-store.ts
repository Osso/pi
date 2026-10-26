import { withControlDb } from "./session-control-db.ts";

export interface Reminder {
	id: number;
	title: string;
	notes: string;
	projectPath?: string;
	dueAt: string;
	status: "open" | "done";
	createdAt: string;
	completedAt?: string;
	/** When this due reminder was written into the delivery conversation; cleared by rescheduling or reopening. */
	deliveredAt?: string;
}

type CreateReminderInput = { title: string; notes?: string; projectPath?: string; dueAt: string };
type ReminderPatch = { title?: string; notes?: string; projectPath?: string | null; dueAt?: string };
type ReminderRow = Omit<Reminder, "projectPath" | "completedAt" | "deliveredAt"> & {
	projectPath: string | null;
	completedAt: string | null;
	deliveredAt: string | null;
};

const REMINDER_COLUMNS = `id, title, notes, project_path AS projectPath, due_at AS dueAt,
	status, created_at AS createdAt, completed_at AS completedAt, delivered_at AS deliveredAt`;

export function createReminder(controlDbPath: string, input: CreateReminderInput): Reminder {
	validateTitle(input.title);
	const dueAt = canonicalizeDueAt(input.dueAt);
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(`INSERT INTO reminders (title, notes, project_path, due_at, status, created_at)
			VALUES (?, ?, ?, ?, 'open', ?) RETURNING ${REMINDER_COLUMNS}`)
			.get(input.title, input.notes ?? "", input.projectPath ?? null, dueAt, new Date().toISOString()) as
			| ReminderRow
			| undefined;
		if (!row) throw new Error("Reminder creation returned no row");
		return reminderFromRow(row);
	});
}

export function listReminders(controlDbPath: string, status: "open" | "done" | "all" = "open"): Reminder[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(`SELECT ${REMINDER_COLUMNS} FROM reminders
			WHERE (? = 'all' OR status = ?) ORDER BY due_at, id`)
			.all(status, status) as ReminderRow[];
		return rows.map((row) => reminderFromRow(row));
	});
}

export function updateReminder(controlDbPath: string, id: number, patch: ReminderPatch): Reminder {
	validateId(id);
	if ([patch.title, patch.notes, patch.projectPath, patch.dueAt].every((value) => value === undefined)) {
		throw new Error("Reminder edit must contain at least one field");
	}
	if (patch.title !== undefined) validateTitle(patch.title);
	const dueAt = patch.dueAt === undefined ? null : canonicalizeDueAt(patch.dueAt);
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(`UPDATE reminders SET
			title = COALESCE(?, title), notes = COALESCE(?, notes),
			project_path = CASE WHEN ? THEN ? ELSE project_path END,
			due_at = COALESCE(?, due_at),
			delivered_at = CASE WHEN COALESCE(?, due_at) = due_at THEN delivered_at ELSE NULL END
			WHERE id = ? RETURNING ${REMINDER_COLUMNS}`)
			.get(
				patch.title ?? null,
				patch.notes ?? null,
				Number(patch.projectPath !== undefined),
				patch.projectPath ?? null,
				dueAt,
				dueAt,
				id,
			) as ReminderRow | undefined;
		return reminderFromRow(row, id);
	});
}

export function completeReminder(controlDbPath: string, id: number): Reminder {
	validateId(id);
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(`UPDATE reminders SET status = 'done', completed_at = COALESCE(completed_at, ?)
			WHERE id = ? RETURNING ${REMINDER_COLUMNS}`)
			.get(new Date().toISOString(), id) as ReminderRow | undefined;
		return reminderFromRow(row, id);
	});
}

export function reopenReminder(controlDbPath: string, id: number): Reminder {
	validateId(id);
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(`UPDATE reminders SET status = 'open', completed_at = NULL, delivered_at = NULL
			WHERE id = ? RETURNING ${REMINDER_COLUMNS}`)
			.get(id) as ReminderRow | undefined;
		return reminderFromRow(row, id);
	});
}

/** Open reminders due by `now` whose delivery has not been acknowledged. */
export function listUndeliveredDueReminders(controlDbPath: string, now: Date): Reminder[] {
	return withControlDb(controlDbPath, (db) => {
		const rows = db
			.prepare(`SELECT ${REMINDER_COLUMNS} FROM reminders
			WHERE status = 'open' AND delivered_at IS NULL AND due_at <= ? ORDER BY due_at, id`)
			.all(now.toISOString()) as ReminderRow[];
		return rows.map((row) => reminderFromRow(row));
	});
}

/**
 * Acknowledge delivery of the reminder instance due at `dueAt`. Returns undefined when that
 * instance no longer awaits delivery (rescheduled, completed, or already acknowledged).
 */
export function markReminderDelivered(
	controlDbPath: string,
	id: number,
	dueAt: string,
	deliveredAt: Date,
): Reminder | undefined {
	validateId(id);
	return withControlDb(controlDbPath, (db) => {
		const row = db
			.prepare(`UPDATE reminders SET delivered_at = ?
			WHERE id = ? AND due_at = ? AND status = 'open' AND delivered_at IS NULL RETURNING ${REMINDER_COLUMNS}`)
			.get(deliveredAt.toISOString(), id, dueAt) as ReminderRow | undefined;
		return row ? reminderFromRow(row) : undefined;
	});
}

export function deleteReminder(controlDbPath: string, id: number): void {
	validateId(id);
	withControlDb(controlDbPath, (db) => {
		const result = db.prepare("DELETE FROM reminders WHERE id = ?").run(id);
		if (result.changes !== 1) throw new Error(`Reminder ${id} not found`);
	});
}

function reminderFromRow(row: ReminderRow | undefined, id?: number): Reminder {
	if (!row) throw new Error(`Reminder ${id} not found`);
	const { projectPath, completedAt, deliveredAt, ...reminder } = row;
	return {
		...reminder,
		...(projectPath === null ? {} : { projectPath }),
		...(completedAt === null ? {} : { completedAt }),
		...(deliveredAt === null ? {} : { deliveredAt }),
	};
}

function validateTitle(title: string): void {
	if (typeof title !== "string" || title.trim().length === 0) throw new Error("Reminder title must not be empty");
}

function validateId(id: number): void {
	if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Reminder ID must be a positive safe integer");
}

function canonicalizeDueAt(value: string): string {
	const match =
		typeof value === "string"
			? /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.exec(
					value,
				)
			: null;
	if (!match) throw new Error("Reminder dueAt must be a valid ISO timestamp with an explicit offset");
	const timestamp = new Date(value);
	const calendarDate = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
	if (!Number.isFinite(timestamp.getTime()) || calendarDate.getUTCDate() !== Number(match[3])) {
		throw new Error("Reminder dueAt must be a valid ISO timestamp with an explicit offset");
	}
	return timestamp.toISOString();
}
