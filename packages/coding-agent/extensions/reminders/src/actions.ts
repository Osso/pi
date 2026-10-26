import {
	completeReminder,
	createReminder,
	deleteReminder,
	listReminders,
	type Reminder,
	reopenReminder,
	updateReminder,
} from "../../../src/core/reminder-store.ts";
import { formatReminderDueAt, isReminderDueToday, parseReminderDueAt } from "../../../src/core/reminder-time.ts";

export const REMINDER_ACTIONS = ["list", "add", "edit", "reschedule", "complete", "reopen", "delete"] as const;
export const REMINDER_LIST_STATUSES = ["open", "done", "all", "due"] as const;

export interface ReminderRequest {
	action: (typeof REMINDER_ACTIONS)[number];
	id?: number;
	title?: string;
	notes?: string;
	projectPath?: string | null;
	dueAt?: string;
	status?: (typeof REMINDER_LIST_STATUSES)[number];
}

function requireText(value: string | undefined, field: string): string {
	if (!value?.trim()) throw new Error(`${field} is required.`);
	return value.trim();
}

function mutateExistingReminder(path: string, request: ReminderRequest): Reminder[] {
	if (request.id === undefined) throw new Error("Reminder id is required.");
	switch (request.action) {
		case "complete":
			return [completeReminder(path, request.id)];
		case "reopen":
			return [reopenReminder(path, request.id)];
		case "delete":
			deleteReminder(path, request.id);
			return [];
		case "reschedule":
			return [updateReminder(path, request.id, { dueAt: parseReminderDueAt(requireText(request.dueAt, "dueAt")) })];
		case "edit":
			return [
				updateReminder(path, request.id, {
					title: request.title,
					notes: request.notes,
					projectPath: request.projectPath,
					dueAt: request.dueAt === undefined ? undefined : parseReminderDueAt(request.dueAt),
				}),
			];
		default:
			throw new Error(`Unsupported reminder action: ${request.action}`);
	}
}

export function executeReminderAction(path: string, request: ReminderRequest, now: Date): Reminder[] {
	if (request.action === "list") {
		const status = request.status ?? "open";
		const reminders = listReminders(path, status === "due" ? "open" : status);
		return status === "due" ? reminders.filter((reminder) => isReminderDueToday(reminder.dueAt, now)) : reminders;
	}
	if (request.action === "add") {
		return [
			createReminder(path, {
				title: requireText(request.title, "title"),
				notes: request.notes,
				projectPath: request.projectPath ?? undefined,
				dueAt: parseReminderDueAt(requireText(request.dueAt, "dueAt")),
			}),
		];
	}
	return mutateExistingReminder(path, request);
}

export function formatReminder(reminder: Reminder): string {
	const project = reminder.projectPath ? ` (project: ${reminder.projectPath})` : "";
	const heading = `#${reminder.id} [${reminder.status}] due ${formatReminderDueAt(reminder.dueAt)}: ${reminder.title}${project}`;
	return reminder.notes ? `${heading}\n  ${reminder.notes.replaceAll("\n", "\n  ")}` : heading;
}

export function describeResult(request: ReminderRequest, reminders: Reminder[]): string {
	if (request.action === "delete") return `Deleted reminder #${request.id}.`;
	if (request.action === "list") {
		if (reminders.length === 0) return `No ${request.status ?? "open"} reminders.`;
		return reminders.map(formatReminder).join("\n");
	}
	const verb = { add: "Added", edit: "Edited", reschedule: "Rescheduled", complete: "Completed", reopen: "Reopened" }[
		request.action
	];
	return `${verb} reminder ${formatReminder(reminders[0])}`;
}
