# Reminders

Reminders are persistent, time-bound follow-ups shared across Pi sessions and projects for one OS user on one machine. They are not an agent's working task list. This is an approved design, not an implemented feature; no source files or tests implement it yet.

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

### Startup and manual access

- [ ] At startup, show open reminders that are overdue or due later that local day, and include the same reminder summary in agent context.
- [ ] Exclude completed reminders from the startup summary. Showing a reminder must not mutate its status.
- [ ] Provide `/reminders` to list open reminders across projects manually.
- [ ] Provide user commands and an agent tool to list, add, edit, reschedule, complete, and delete reminders.
- [ ] Check deadlines at startup or on manual request; passing a deadline while Pi is closed does not trigger any action.

## How it works

Implementation design is pending. Storage ownership is part of the contract above; table layout, tool schemas, and command syntax are not specified yet.

## Implementation inventory

None. This change records the design only.

## Tests asserting this spec

None. All requirements remain unchecked until behavior is implemented and tested.

## Known gaps (current cycle)

- [ ] Before implementation, define whether startup checks also run on new-session creation and session switches, and whether non-interactive runs receive reminder context.
- [ ] Before implementation, define whether completed reminders can be reopened.
- [ ] Implement and test the contract, including persistence across sessions/restarts, global visibility across projects, date/time behavior, and reminder-versus-plan guidance.
- [ ] When shipping, reconcile the README's "No built-in to-dos" wording with the distinction between Reminders and active-work planning.

## Out of scope

- Automatic execution or agent dispatch: reminders do not authorize work.
- A scheduler, daemon, or background polling: startup and manual checks are sufficient for this version.
- Cross-machine synchronization, recurrence, or task-claim ownership: this is a machine-local reminder list, not a work scheduler.
- Implementation planning: `PLAN.md` remains the place for active-goal tasks and progress.
