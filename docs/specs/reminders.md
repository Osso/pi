# Reminders

Reminders are persistent, time-bound follow-ups shared across Pi sessions and projects for one OS user on one machine. They are not an agent's working task list. This feature is not integrated or deployed. Storage and date-handling drafts exist; delivery is being redesigned around the [machine assistant](machine-assistant.md).

## What it must do

### Purpose and agent behavior

- [ ] Store durable future follow-ups, not active-goal steps, subtasks, test checklists, or session progress. Those belong in `PLAN.md`.
- [ ] Allow agents to infer useful reminders and create them without an explicit user command or approval. Report each addition with its ID and due date and time.
- [ ] State this boundary in the reminder tool description and agent instructions, not only in user documentation.
- [ ] Treat reminders as context, not authorization to execute work. Showing or reading a reminder neither starts work nor completes it.

For example, "Recheck security advisories tomorrow at 09:00" belongs in Reminders. "Audit images, patch services, run tests" belongs in `PLAN.md`. A deadline alone does not turn an active-work step into a reminder.

### Persistence and data

- [ ] Make Reminders a supported Pi feature in the control SQLite database, with schema ownership and migrations maintained by Pi; do not insert extension-private tables into it.
- [ ] Share one reminder list across local sessions and projects for the same OS user. Reminders survive session completion and process restart.
- [ ] Give each reminder an ID, title, notes, optional project path, exact due timestamp, open/done status, creation timestamp, and completion timestamp when completed.
- [ ] Keep the project path as optional context; it must not split the global list by current working directory.

### Date and time

- [ ] Store due timestamps as UTC instants and display them in the machine's local timezone, including the timezone in displayed due times.
- [ ] Interpret input without an explicit timezone in the machine's local timezone. Clarify ambiguous dates or times instead of silently guessing.
- [ ] Preserve the stored instant if the machine's timezone changes.

### Delivery and manual access

- [ ] Delegate automatic reminder delivery to the [machine assistant](machine-assistant.md), rather than alerting every interactive project session. This supersedes the initial startup/manual-only delivery proposal.
- [ ] Exclude completed reminders from due summaries. Showing a reminder must not mutate its status.
- [ ] Provide `/reminders` to list open reminders across projects manually.
- [ ] Provide user commands and an agent tool to list, add, edit, reschedule, complete, reopen, and delete reminders. Reopening is explicit; editing or rescheduling must not implicitly reopen a completed reminder.

## How it works

Implementation design is pending. Storage ownership is part of the contract above; table layout, tool schemas, and command syntax are not specified yet.

## Implementation inventory

Storage and date-handling drafts await integration. No complete user-facing Reminders feature is available yet.

## Tests asserting this spec

Draft storage and date-handling tests exist, but the integrated feature is not verified. Requirements remain unchecked.

## Known gaps (current cycle)

- [ ] Resume integration only after the machine-assistant delivery design is settled. Interactive-startup-only checks were selected before the user chose a dedicated persistent assistant instead.
- [ ] Implement and test the contract, including persistence across sessions/restarts, global visibility across projects, date/time behavior, and reminder-versus-plan guidance.
- [ ] When shipping, reconcile the README's "No built-in to-dos" wording with the distinction between Reminders and active-work planning.

## Out of scope

- Automatic execution or agent dispatch: reminders do not authorize work.
- Scheduling and service supervision within reminder storage: those responsibilities belong to the [machine assistant](machine-assistant.md).
- Cross-machine synchronization, recurrence, or task-claim ownership: this is a machine-local reminder list, not a work scheduler.
- Implementation planning: `PLAN.md` remains the place for active-goal tasks and progress.
