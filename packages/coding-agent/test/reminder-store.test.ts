import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	completeReminder,
	createReminder,
	deleteReminder,
	listReminders,
	listUndeliveredDueReminders,
	markReminderDelivered,
	reopenReminder,
	updateReminder,
} from "../src/core/reminder-store.ts";
import { withControlDb } from "../src/core/session-control-db.ts";
import { createSqliteDatabase } from "../src/core/sqlite.ts";

let directory: string;
let controlDbPath: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-reminder-store-"));
	controlDbPath = join(directory, "control.sqlite");
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

const dueAt = "2026-11-01T12:00:00.000Z";

describe("reminder store", () => {
	it("creates reminders with defaults, UTC due time, and creation time", () => {
		const before = Date.now();
		const reminder = createReminder(controlDbPath, {
			title: "Review invoice",
			dueAt: "2026-11-01T07:00:00-05:00",
		});
		expect(reminder).toEqual({
			id: expect.any(Number),
			title: "Review invoice",
			notes: "",
			dueAt,
			status: "open",
			createdAt: expect.any(String),
		});
		expect(reminder.id).toBeGreaterThan(0);
		expect(new Date(reminder.createdAt).toISOString()).toBe(reminder.createdAt);
		expect(Date.parse(reminder.createdAt)).toBeGreaterThanOrEqual(before);
		expect(Date.parse(reminder.createdAt)).toBeLessThanOrEqual(Date.now());
		expect(listReminders(controlDbPath)).toEqual([reminder]);
	});

	it("round trips notes and project paths without interpreting their contents", () => {
		const reminder = createReminder(controlDbPath, {
			title: "Review 'invoice'; DELETE FROM reminders; --",
			notes: "Line 1\nLine 2",
			projectPath: "/projects/invoice",
			dueAt,
		});
		expect(listReminders(controlDbPath)).toEqual([reminder]);
		expect(reminder.notes).toBe("Line 1\nLine 2");
		expect(reminder.projectPath).toBe("/projects/invoice");
	});

	it("lists open by default and filters all statuses in due-time then ID order", () => {
		expect(listReminders(controlDbPath)).toEqual([]);
		const late = createReminder(controlDbPath, { title: "Late", dueAt: "2026-12-01T00:00:00Z" });
		const first = createReminder(controlDbPath, { title: "First", dueAt });
		const second = createReminder(controlDbPath, { title: "Second", dueAt: "2026-11-01T13:00:00+01:00" });
		const done = completeReminder(controlDbPath, first.id);
		expect(listReminders(controlDbPath)).toEqual([second, late]);
		expect(listReminders(controlDbPath, "open")).toEqual([second, late]);
		expect(listReminders(controlDbPath, "done")).toEqual([done]);
		expect(listReminders(controlDbPath, "all")).toEqual([done, second, late]);
	});

	it("edits fields independently, clears optional fields, and preserves identity and creation time", () => {
		const reminder = createReminder(controlDbPath, {
			title: "Original",
			notes: "Original notes",
			projectPath: "/projects/one",
			dueAt,
		});
		const renamed = updateReminder(controlDbPath, reminder.id, { title: "Renamed" });
		expect(renamed).toEqual({ ...reminder, title: "Renamed" });
		const edited = updateReminder(controlDbPath, reminder.id, {
			notes: "New notes",
			projectPath: "/projects/two",
			dueAt: "2026-12-01T10:00:00+02:00",
		});
		expect(edited).toEqual({
			...renamed,
			notes: "New notes",
			projectPath: "/projects/two",
			dueAt: "2026-12-01T08:00:00.000Z",
		});
		const cleared = updateReminder(controlDbPath, reminder.id, { notes: "", projectPath: null });
		expect(cleared.notes).toBe("");
		expect(cleared.projectPath).toBeUndefined();
		expect(listReminders(controlDbPath)).toEqual([cleared]);
	});

	it("completes idempotently with a stable timestamp and does not reopen on edit or reschedule", async () => {
		const reminder = createReminder(controlDbPath, { title: "Invoice", dueAt });
		const before = Date.now();
		const completed = completeReminder(controlDbPath, reminder.id);
		expect(completed).toEqual({ ...reminder, status: "done", completedAt: expect.any(String) });
		expect(Date.parse(completed.completedAt!)).toBeGreaterThanOrEqual(before);
		expect(Date.parse(completed.completedAt!)).toBeLessThanOrEqual(Date.now());
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(completeReminder(controlDbPath, reminder.id)).toEqual(completed);
		const edited = updateReminder(controlDbPath, reminder.id, {
			title: "Paid invoice",
			dueAt: "2027-01-01T00:00:00Z",
		});
		expect(edited).toEqual({ ...completed, title: "Paid invoice", dueAt: "2027-01-01T00:00:00.000Z" });
		expect(listReminders(controlDbPath)).toEqual([]);
		expect(listReminders(controlDbPath, "done")).toEqual([edited]);
	});

	it("reopens explicitly, clears completion, and is idempotent when open", () => {
		const reminder = createReminder(controlDbPath, { title: "Invoice", dueAt });
		expect(reopenReminder(controlDbPath, reminder.id)).toEqual(reminder);
		completeReminder(controlDbPath, reminder.id);
		const reopened = reopenReminder(controlDbPath, reminder.id);
		expect(reopened).toEqual(reminder);
		expect(reopenReminder(controlDbPath, reminder.id)).toEqual(reminder);
		expect(listReminders(controlDbPath)).toEqual([reminder]);
		expect(listReminders(controlDbPath, "done")).toEqual([]);
	});

	it("deletes open and done reminders and never reuses a deleted ID", () => {
		const first = createReminder(controlDbPath, { title: "First", dueAt });
		const second = createReminder(controlDbPath, { title: "Second", dueAt });
		completeReminder(controlDbPath, second.id);
		deleteReminder(controlDbPath, first.id);
		deleteReminder(controlDbPath, second.id);
		expect(listReminders(controlDbPath, "all")).toEqual([]);
		expect(createReminder(controlDbPath, { title: "Third", dueAt }).id).toBeGreaterThan(second.id);
	});

	it.each(["", "  ", "\n\t"])("rejects empty title %j for create and edit", (title) => {
		expect(() => createReminder(controlDbPath, { title, dueAt })).toThrow(/title/i);
		const reminder = createReminder(controlDbPath, { title: "Original", dueAt });
		expect(() => updateReminder(controlDbPath, reminder.id, { title })).toThrow(/title/i);
		expect(listReminders(controlDbPath)).toEqual([reminder]);
	});

	it.each([
		"",
		"not a date",
		"2026-11-01",
		"2026-11-01T12:00:00",
		"11/01/2026 12:00:00 GMT",
		"2026-02-30T12:00:00Z",
		"2026-13-01T12:00:00Z",
		"2026-11-01T24:00:00Z",
		"2026-11-01T12:60:00Z",
		"2026-11-01T12:00:60Z",
		"2026-11-01T12:00:00+24:00",
	])("rejects invalid or offset-free due time %j without changing data", (invalidDueAt) => {
		expect(() => createReminder(controlDbPath, { title: "Invoice", dueAt: invalidDueAt })).toThrow(/dueAt/i);
		const reminder = createReminder(controlDbPath, { title: "Invoice", dueAt });
		expect(() => updateReminder(controlDbPath, reminder.id, { dueAt: invalidDueAt })).toThrow(/dueAt/i);
		expect(listReminders(controlDbPath)).toEqual([reminder]);
	});

	it.each([
		["2024-02-29T23:15:00-02:00", "2024-03-01T01:15:00.000Z"],
		["2026-11-01T12:00+02:30", "2026-11-01T09:30:00.000Z"],
		["2026-11-01T12:00:00.123Z", "2026-11-01T12:00:00.123Z"],
	])("canonicalizes ISO due time %s", (input, expected) => {
		expect(createReminder(controlDbPath, { title: "Invoice", dueAt: input }).dueAt).toBe(expected);
	});

	it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid ID %s", (id) => {
		expect(() => updateReminder(controlDbPath, id, { title: "New" })).toThrow(/id/i);
		expect(() => completeReminder(controlDbPath, id)).toThrow(/id/i);
		expect(() => reopenReminder(controlDbPath, id)).toThrow(/id/i);
		expect(() => deleteReminder(controlDbPath, id)).toThrow(/id/i);
	});

	it("reports missing rows explicitly for every mutation", () => {
		expect(() => updateReminder(controlDbPath, 123, { title: "New" })).toThrow(/123.*not found|not found.*123/i);
		expect(() => completeReminder(controlDbPath, 123)).toThrow(/123.*not found|not found.*123/i);
		expect(() => reopenReminder(controlDbPath, 123)).toThrow(/123.*not found|not found.*123/i);
		expect(() => deleteReminder(controlDbPath, 123)).toThrow(/123.*not found|not found.*123/i);
	});

	it("rejects edits with no defined fields", () => {
		const reminder = createReminder(controlDbPath, { title: "Invoice", dueAt });
		expect(() => updateReminder(controlDbPath, reminder.id, {})).toThrow(/empty|at least one/i);
		expect(() => updateReminder(controlDbPath, reminder.id, { title: undefined })).toThrow(/empty|at least one/i);
		expect(listReminders(controlDbPath)).toEqual([reminder]);
	});
});

describe("reminder schema initialization", () => {
	it("creates global reminders in a fresh database and preserves them on reopen", () => {
		const reminder = withControlDb(controlDbPath, (db) =>
			db
				.prepare(`INSERT INTO reminders (title, notes, due_at, status, created_at)
				VALUES (?, ?, ?, 'open', ?) RETURNING *`)
				.get("Review invoice", "", "2026-11-01T12:00:00.000Z", "2026-10-25T12:00:00.000Z"),
		);
		const reopened = createSqliteDatabase(controlDbPath);
		try {
			expect(reopened.prepare("SELECT * FROM reminders").all()).toEqual([reminder]);
		} finally {
			reopened.close();
		}
		expect(withControlDb(controlDbPath, (db) => db.prepare("SELECT * FROM reminders").all())).toEqual([reminder]);
	});

	it("adds reminders to a current database without changing its version or existing data", () => {
		withControlDb(controlDbPath, (db) => {
			db.exec("DROP TABLE IF EXISTS reminders");
			db.prepare("INSERT INTO prompt_history (content, created_at) VALUES (?, ?)").run(
				"Keep this prompt",
				"2026-10-25T12:00:00.000Z",
			);
			db.prepare("INSERT INTO multi_agent_counters_v2 VALUES (?, ?, ?, ?)").run(
				"/sessions/main.jsonl",
				7,
				11,
				"2026-10-25T12:00:00.000Z",
			);
		});
		const before = createSqliteDatabase(controlDbPath);
		let version: unknown;
		try {
			version = before.prepare("PRAGMA user_version").get();
		} finally {
			before.close();
		}
		withControlDb(controlDbPath, (db) => {
			expect(db.prepare("SELECT * FROM reminders").all()).toEqual([]);
			expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
			expect(db.prepare("SELECT content, created_at FROM prompt_history").all()).toEqual([
				{ content: "Keep this prompt", created_at: "2026-10-25T12:00:00.000Z" },
			]);
			expect(db.prepare("SELECT * FROM multi_agent_counters_v2").all()).toEqual([
				{
					session_path: "/sessions/main.jsonl",
					next_agent_number: 7,
					next_message_number: 11,
					updated_at: "2026-10-25T12:00:00.000Z",
				},
			]);
		});
	});

	it.each([
		["open", "2026-10-25T12:00:00.000Z"],
		["done", null],
		["done", ""],
		["done", "not a timestamp"],
		["cancelled", null],
	])("rejects inconsistent status %s and completion %s at the database boundary", (status, completedAt) => {
		withControlDb(controlDbPath, (db) => {
			expect(() =>
				db
					.prepare(`INSERT INTO reminders (title, notes, due_at, status, created_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?)`)
					.run("Invoice", "", "2026-11-01T12:00:00.000Z", status, "2026-10-25T12:00:00.000Z", completedAt),
			).toThrow(/constraint/i);
		});
	});
});

describe("reminder delivery acknowledgement", () => {
	const now = new Date("2026-11-01T12:00:00.000Z");

	it("lists open due reminders until each is marked delivered, leaving future and completed ones", () => {
		const overdue = createReminder(controlDbPath, { title: "Overdue", dueAt: "2026-10-30T09:00:00Z" });
		const exact = createReminder(controlDbPath, { title: "Exact", dueAt });
		createReminder(controlDbPath, { title: "Future", dueAt: "2026-11-01T12:00:01Z" });
		const done = createReminder(controlDbPath, { title: "Done", dueAt: "2026-10-29T09:00:00Z" });
		completeReminder(controlDbPath, done.id);

		const due = listUndeliveredDueReminders(controlDbPath, now);
		expect(due.map((reminder) => reminder.title)).toEqual(["Overdue", "Exact"]);
		expect(listUndeliveredDueReminders(controlDbPath, now)).toEqual(due);
		expect(due.every((reminder) => reminder.deliveredAt === undefined)).toBe(true);

		const delivered = markReminderDelivered(controlDbPath, overdue.id, overdue.dueAt, now);
		expect(delivered?.deliveredAt).toBe(now.toISOString());
		expect(delivered?.status).toBe("open");
		expect(listUndeliveredDueReminders(controlDbPath, now).map((reminder) => reminder.id)).toEqual([exact.id]);
	});

	it("does not mark a reminder rescheduled after its delivery was sent", () => {
		const moved = createReminder(controlDbPath, { title: "Moved", dueAt: "2026-10-30T09:00:00Z" });
		updateReminder(controlDbPath, moved.id, { dueAt: "2026-11-01T11:00:00Z" });
		expect(markReminderDelivered(controlDbPath, moved.id, moved.dueAt, now)).toBeUndefined();
		expect(listUndeliveredDueReminders(controlDbPath, now).map((reminder) => reminder.title)).toEqual(["Moved"]);
	});

	it("re-arms delivery when a delivered reminder is rescheduled or reopened", () => {
		const moved = createReminder(controlDbPath, { title: "Moved", dueAt: "2026-10-30T09:00:00Z" });
		const reopened = createReminder(controlDbPath, { title: "Reopened", dueAt: "2026-10-30T10:00:00Z" });
		for (const reminder of [moved, reopened]) markReminderDelivered(controlDbPath, reminder.id, reminder.dueAt, now);
		expect(listUndeliveredDueReminders(controlDbPath, now)).toEqual([]);

		updateReminder(controlDbPath, moved.id, { dueAt: "2026-11-01T11:00:00Z" });
		updateReminder(controlDbPath, reopened.id, { title: "Reopened later" });
		completeReminder(controlDbPath, reopened.id);
		reopenReminder(controlDbPath, reopened.id);

		expect(listUndeliveredDueReminders(controlDbPath, now).map((reminder) => reminder.title)).toEqual([
			"Reopened later",
			"Moved",
		]);
	});

	it("does not re-arm delivery for edits that keep the due time", () => {
		const reminder = createReminder(controlDbPath, { title: "Stable", dueAt: "2026-10-30T09:00:00Z" });
		markReminderDelivered(controlDbPath, reminder.id, reminder.dueAt, now);
		updateReminder(controlDbPath, reminder.id, { notes: "More context", dueAt: "2026-10-30T04:00:00-05:00" });
		expect(listUndeliveredDueReminders(controlDbPath, now)).toEqual([]);
	});
});
