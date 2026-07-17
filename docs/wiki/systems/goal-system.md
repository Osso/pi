# Goal System

The goal system is implemented as a first-party coding-agent extension in
`packages/coding-agent/extensions/goal/`. It provides `/goal` plus a
`manage_goal` tool, persists one active objective per session in control SQLite
metadata, and keeps that objective in the system prompt until it is completed or
another continuation stop condition is reached.

The contract lives in `docs/specs/goal-system.md`.

## State

Goal state is stored as JSON in the current session's `session_metadata.goal_json`
row in the control SQLite database. The same `session_metadata` row stores
`is_subagent` and `subagent_name` for session classification. Production-created
`spawn_agent` children and `/bg` jobs start without goal metadata; production
`attach_session_agent` runtimes reuse the target session and may retain existing
`goal_json`, but all three runtime paths exclude this extension.

The persisted record contains:

- `objective`: the active goal text.
- `branch`: the git branch when the goal was created, or `(no branch)` if branch
  lookup fails.
- `createdAt`: ISO timestamp for creation.
- `completedAt` and `completionReason`: set when `manage_goal` marks the goal
  complete.
- `continuationTurns`: number of automatic continuation turns already sent.

Missing state means no active goal. Corrupt JSON is also treated as no active
goal; the command and prompt hook do not throw.

## Slash Command

`/goal` is registered by the extension as a normal Pi slash command.

`/goal set <objective>` creates or replaces a goal, persists it, and notifies the UI.
Bare `/goal <text>` input is rejected so words such as `continue` cannot replace durable goal state.
If the agent is idle, Pi sends the unambiguous reminder:

```text
Continue working toward the active goal.
```

Goal start and `/goal resume` use this same reminder when the session is idle; neither reminder restates the objective or `/goal set` syntax.

If the agent is busy, the goal is saved and Pi shows an informational notice
instead of starting a second turn.

`/goal` with no arguments displays the current objective or a no-goal notice.

`/goal clear` clears the current session's `goal_json` metadata and reports whether anything was cleared.

A second `/goal set <objective>` replaces the active incomplete goal.

Objective text is limited to 4000 characters. Longer objectives are rejected
before state is written.

The command rejects flags with a visible error and does not write state. Removed budget flags keep specific error messages.

The `manage_goal` tool exposes an `action` parameter with optional `objective`
and `reason` parameters. It can set, pause, resume, complete, clear, or view the
current active goal. The set action rejects reserved goal-control words such as
`continue`, preventing model-generated continuation instructions from becoming objectives. Paused goals remain visible in `/goal`, startup
notifications, and footer status, but do not inject prompt context or continue
automatically until the resume action clears the pause state.

`manage_goal` is supervisor-only. The SDK denylist removes that capability from
spawned, attached/resumed, and `/bg` child sessions, and from the resident
Architect service, after extension registration. This blocks external extensions
that try to register the same tool name; `pi.tools.call` also fails because the
tool is inactive. The supervisor keeps the capability.

## Prompt Injection

The extension listens for `before_agent_start`. When an active goal exists, it
appends a `<goal>` block to the assembled system prompt. The block includes the
objective, branch, creation timestamp, and continuation turns.

The injected instructions tell the model to keep working until the goal is
achieved and to report blockers instead of stopping silently.

## Footer Status

The extension shows the active objective in the footer status line as
`goal: <objective>`. Setting, restoring, clearing, or completing a goal updates
that status.

## Session Start

The extension listens for `session_start`. If the current session's `goal_json`
contains a goal, Pi notifies the user with the restored objective and shows it in
the footer. Resume restores only the resumed session's own goal state; it does not
inherit from `previousSessionFile`.

Capability filtering is separate from first-party extension filtering: child
factories still omit `<first-party:goal>`, while the SDK denylist filters every
registered tool named `manage_goal` regardless of source.

Fork is the only start reason that inherits from `previousSessionFile`. When a
normal fork starts with a new session id and no current goal, the extension reads
the parent's `goal_json` and copies the parent's active goal into the fork's
metadata row. Production-created `spawn_agent` children and `/bg` jobs are marked
with `is_subagent`, exclude the goal extension, and do not seed or inherit goal
state. Production `attach_session_agent` runtimes also exclude the extension and
never seed or copy goal metadata; any existing target `goal_json` remains inert.

## Automatic Continuation

The extension listens for `agent_end`. If a goal is active, incomplete, and there are no pending messages, it requests `goal_idle_review` from the resident Supervisor. `continue` increments `continuationTurns` and submits the returned actionable instructions. `complete` closes the goal. `pause` pauses it without another turn. `error` leaves it active, reports the failure, and stops automatic continuation.

Review does not start when:

- the goal has `completedAt` or is paused;
- pending messages exist;
- the last assistant response was empty.

Pending input is checked before abort handling. Interactive replacement input remains pending through `AgentSession.hasPendingMessages()` while its external-input reservation exists, even after the steering queue entry is consumed. An aborted turn with pending input keeps the goal running; an abort without pending input pauses it.

When an empty response stops continuation, Pi shows a warning explaining the stop reason.

## Completion Tool Action

Calling `manage_goal` with action `complete` requests `goal_completion_review` before changing state. `complete` writes `completedAt` and `completionReason`; `continue` keeps the goal running and submits actionable instructions; `pause` writes `pausedAt`; `error` leaves the goal active and reports the failure. If no active goal exists, the tool returns "No active goal to complete."

Completed and paused goals do not trigger automatic continuation.

## Tests

`packages/coding-agent/test/goal-extension.test.ts` covers the implemented
behavior: first-party registration, explicit `/goal set`, bare-objective and reserved-control-word rejection, `manage_goal`, view/clear, replacement, removed replacement flag rejection, objective length rejection,
prompt injection, continuation state without budget lines, footer status,
session-start restore notifications, fork-only goal inheritance, corrupt state
handling, automatic continuation, busy guard, per-session isolation, budget flag
rejection, and legacy budget field ignorance. Production child exclusion,
external-tool denial for spawned and attached sessions, inactive Pyrun calls,
supervisor retention, and no-continuation behavior are covered by
`packages/coding-agent/test/multi-agent-extension.test.ts`; the Architect policy
is covered by `packages/coding-agent/test/architect-service.test.ts`.
