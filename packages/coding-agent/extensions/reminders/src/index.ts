import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	describeResult,
	executeReminderAction,
	REMINDER_ACTIONS,
	REMINDER_LIST_STATUSES,
	type ReminderRequest,
} from "./actions.ts";
import { notifyDesktop, ReminderDelivery, type ReminderNotifier } from "./delivery.ts";

interface ReminderOptions {
	controlDbPath?: string;
	now?: () => Date;
	deliveryIntervalMs?: number;
	notify?: ReminderNotifier;
}

const DUE_AT_HELP =
	"Exact due time: local 'YYYY-MM-DD HH:mm' or 'YYYY-MM-DDTHH:mm', or ISO with Z/+HH:MM. Resolve relative dates yourself and ask the user when the date or time is ambiguous.";

const COMMAND_USAGE =
	"Usage: /reminders [list [open|done|all|due]] | add <due> <title> | edit <id> <title> | notes <id> <text> | reschedule <id> <due> | done <id> | reopen <id> | delete <id>. <due> is 'YYYY-MM-DD HH:mm' local time or ISO with offset.";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_CLOCK = /^\d{2}:\d{2}(?::\d{2})?$/;

/** Split a leading due time (one ISO token or local date + clock) from the remaining words. */
function takeDueAt(words: string[]): { dueAt: string; rest: string[] } {
	const [first = "", second = ""] = words;
	if (LOCAL_DATE.test(first) && LOCAL_CLOCK.test(second)) return { dueAt: `${first} ${second}`, rest: words.slice(2) };
	return { dueAt: first, rest: words.slice(1) };
}

function parseId(text: string | undefined): number {
	const id = Number(text);
	if (!text || !Number.isSafeInteger(id) || id <= 0) throw new Error(COMMAND_USAGE);
	return id;
}

export function parseRemindersCommand(args: string): ReminderRequest {
	const [verb = "list", ...words] = args.trim().split(/\s+/).filter(Boolean);
	const text = (from: string[]) => from.join(" ");
	switch (verb) {
		case "list": {
			const status = words[0] ?? "open";
			if (!REMINDER_LIST_STATUSES.some((value) => value === status)) throw new Error(COMMAND_USAGE);
			return { action: "list", status: status as ReminderRequest["status"] };
		}
		case "add": {
			const { dueAt, rest } = takeDueAt(words);
			return { action: "add", dueAt, title: text(rest) };
		}
		case "edit":
			return { action: "edit", id: parseId(words[0]), title: text(words.slice(1)) };
		case "notes":
			return { action: "edit", id: parseId(words[0]), notes: text(words.slice(1)) };
		case "reschedule":
			return { action: "reschedule", id: parseId(words[0]), dueAt: takeDueAt(words.slice(1)).dueAt };
		case "done":
			return { action: "complete", id: parseId(words[0]) };
		case "reopen":
		case "delete":
			return { action: verb, id: parseId(words[0]) };
		default:
			throw new Error(COMMAND_USAGE);
	}
}

export default function remindersExtension(pi: ExtensionAPI, options: ReminderOptions = {}): void {
	const now = options.now ?? (() => new Date());
	const delivery = new ReminderDelivery(pi, {
		notify: options.notify ?? notifyDesktop,
		now,
		intervalMs: options.deliveryIntervalMs ?? 60_000,
	});
	const controlDbPath = (ctx: ExtensionContext): string => {
		const path = options.controlDbPath ?? ctx.controlDbPath;
		if (!path) throw new Error("Reminders require the Pi control database.");
		return path;
	};
	const run = (request: ReminderRequest, ctx: ExtensionContext): string =>
		describeResult(request, executeReminderAction(controlDbPath(ctx), request, now()));

	pi.on("session_start", (_event, ctx) => delivery.start(ctx, options.controlDbPath ?? ctx.controlDbPath));
	pi.on("session_shutdown", () => delivery.stop());

	pi.registerTool({
		name: "reminders",
		label: "Reminders",
		description:
			"Persistent reminders shared by all Pi sessions and projects of this OS user: durable future follow-ups with an exact due time. Not a task list: active-goal steps, subtasks, test checklists and progress belong in PLAN.md. A reminder is context, not authorization: listing or reading one never starts or completes work.",
		promptSnippet: "List, add, edit, reschedule, complete, reopen, or delete persistent future follow-up reminders.",
		promptGuidelines: [
			"Use reminders for durable future follow-ups (for example 'recheck security advisories tomorrow at 09:00'); keep active work steps in PLAN.md.",
			"You may add a useful reminder without being asked; tell the user the reminder ID and due time you added.",
			"Reminders are context, not authorization: do not start, skip, or complete work because a reminder exists.",
			"Pass exact due times; resolve relative dates from the current date and ask the user when a date or time is ambiguous.",
		],
		parameters: Type.Object({
			action: Type.Union(REMINDER_ACTIONS.map((action) => Type.Literal(action))),
			id: Type.Optional(Type.Integer({ description: "Reminder ID for edit, reschedule, complete, reopen, delete." })),
			title: Type.Optional(Type.String({ description: "Short reminder title. Required for add." })),
			notes: Type.Optional(Type.String({ description: "Optional details." })),
			projectPath: Type.Optional(Type.String({ description: "Optional project path as context; does not filter." })),
			dueAt: Type.Optional(Type.String({ description: DUE_AT_HELP })),
			status: Type.Optional(
				Type.Union(REMINDER_LIST_STATUSES.map((status) => Type.Literal(status)), {
					description: "List filter: open (default), done, all, or due (overdue and due today).",
				}),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => ({
			content: [{ type: "text", text: run(params, ctx) }],
			details: undefined,
		}),
	});

	pi.registerCommand("reminders", {
		description: "List and manage persistent reminders across projects.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				ctx.ui.notify(run(parseRemindersCommand(args), ctx), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
