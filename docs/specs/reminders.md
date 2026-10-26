# Reminders

Reminders are persistent, time-bound follow-ups shared across Pi sessions and projects for one OS user on one machine. They are not an agent's working task list. Automatic delivery belongs to the [machine assistant](machine-assistant.md).

## What it must do

### Purpose and agent behavior

- [x] Store durable future follow-ups, not active-goal steps, subtasks, test checklists, or session progress. Those belong in `PLAN.md`.
- [x] Allow agents to infer useful reminders and create them without an explicit user command or approval. Report each addition with its ID and due date and time.
- [x] State this boundary in the reminder tool description and agent instructions, not only in user documentation.
- [x] Treat reminders as context, not authorization to execute work. Showing or reading a reminder neither starts work nor completes it.

For example, "Recheck security advisories tomorrow at 09:00" belongs in Reminders. "Audit images, patch services, run tests" belongs in `PLAN.md`. A deadline alone does not turn an active-work step into a reminder.

### Persistence and data

- [x] Make Reminders a supported Pi feature in the control SQLite database, with schema ownership and migrations maintained by Pi; do not insert extension-private tables into it.
- [x] Share one reminder list across local sessions and projects for the same OS user. Reminders survive session completion and process restart.
- [x] Give each reminder an ID, title, notes, optional project path, exact due timestamp, open/done status, creation timestamp, and completion timestamp when completed.
- [x] Keep the project path as optional context; it must not split the global list by current working directory.

### Date and time

- [x] Store due timestamps as UTC instants and display them in the machine's local timezone, including the timezone in displayed due times.
- [x] Interpret input without an explicit timezone in the machine's local timezone. Clarify ambiguous dates or times instead of silently guessing.
- [x] Preserve the stored instant if the machine's timezone changes.

### Delivery and manual access

- [x] Delegate automatic reminder delivery to the [machine assistant](machine-assistant.md), rather than alerting every interactive project session.
- [x] Deliver each due open reminder once: post it into the assistant conversation, start an assistant turn, and send one desktop alert. Rescheduling or reopening re-arms delivery; other edits do not. A reminder that became due while the assistant was not running is delivered at its next start.
- [x] Exclude completed reminders from due summaries. Showing a reminder must not mutate its status.
- [x] Provide `/reminders` to list open reminders across projects manually.
- [x] Provide user commands and an agent tool to list, add, edit, reschedule, complete, reopen, and delete reminders. Reopening is explicit; editing or rescheduling must not implicitly reopen a completed reminder.

## How it works

`reminders` is a control-DB table created by `session-control-db.ts`; `src/core/reminder-store.ts` owns all reads and writes and `src/core/reminder-time.ts` parses and formats due times. Local input such as `2026-10-26 09:00` resolves in the machine timezone and fails in DST gaps or repeated hours; ISO input with `Z` or an offset selects an exact instant.

The first-party `reminders` extension registers the agent tool and `/reminders` command (`list [open|done|all|due]`, `add <due> <title>`, `edit <id> <title>`, `notes <id> <text>`, `reschedule <id> <due>`, `done <id>`, `reopen <id>`, `delete <id>`). Delivery runs only in the session whose ID equals the `reminders.deliverySessionId` setting. That session checks once at start and then every minute without model calls. `claimDueReminders` sets `delivered_at` on open reminders due by now in one update, so each due instant is delivered once even across restarts. The reminder text in the conversation states that it is context, not authorization.

## Implementation inventory

- `packages/coding-agent/src/core/reminder-store.ts`, `reminder-time.ts`: storage, delivery claims, time handling.
- `packages/coding-agent/extensions/reminders/src/`: tool, command, delivery timer.
- `packages/coding-agent/src/core/settings-manager.ts`: `reminders.deliverySessionId`.

## Tests asserting this spec

- `test/reminder-store.test.ts`: persistence, filters, edit/complete/reopen/delete, schema constraints, delivery claims and re-arming.
- `test/reminder-time.test.ts`: local and offset parsing, DST gaps and repeats, display with offset and zone.
- `test/suite/reminders.test.ts`: cross-session visibility and lifecycle through the tool, agent guidance, invalid input, single-session delivery with turn and alert, `/reminders` commands.

## Known gaps (current cycle)

- [ ] Assistant restart supervision is not implemented: delivery stops while the assistant session is not running, and resumes with overdue reminders at its next start.

## Out of scope

- Automatic execution or agent dispatch: reminders do not authorize work.
- Cross-machine synchronization, recurrence, or task-claim ownership: this is a machine-local reminder list, not a work scheduler.
- Implementation planning: `PLAN.md` remains the place for active-goal tasks and progress.
