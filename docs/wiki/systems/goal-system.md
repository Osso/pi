# Goal System

The goal system is implemented as a first-party coding-agent extension in
`packages/coding-agent/extensions/goal/`. It provides `/goal` plus a
`goal_complete` tool, persists one active objective per session in a working
directory, and keeps that objective in the system prompt until it is completed
or another continuation stop condition is reached.

The contract lives in `docs/specs/goal-system.md`.

## State

Goal state is stored as JSON in the current session's `session_metadata.goal_json`
row in the control SQLite database. The same `session_metadata` row stores
`is_subagent` and `subagent_name` so parent sessions and subagents can keep
separate objectives.

The persisted record contains:

- `objective`: the active goal text.
- `branch`: the git branch when the goal was created, or `(no branch)` if branch
  lookup fails.
- `createdAt`: ISO timestamp for creation.
- `completedAt` and `completionReason`: set when `goal_complete` marks the goal
  complete.
- `continuationTurns`: number of automatic continuation turns already sent.

Missing state means no active goal. Corrupt JSON is also treated as no active
goal; the command and prompt hook do not throw.

## Slash Command

`/goal` is registered by the extension as a normal Pi slash command.

`/goal <objective>` creates a goal, persists it, notifies the UI, and if the
agent is idle sends:

```text
Work toward this objective until it is achieved: <objective>
```

If the agent is busy, the goal is saved and a warning is shown instead of
starting a second turn.

`/goal` with no arguments displays the current objective or a no-goal notice.

`/goal clear` clears the current session's `goal_json` metadata and reports whether anything was cleared.

`/goal --replace <objective>` replaces an active, incomplete goal. Without
`--replace`, a second objective is rejected while an incomplete goal exists.

Objective text is limited to 4000 characters. Longer objectives are rejected
before state is written.

The command rejects the removed `--token-budget` and `--wall-clock-minutes` flags with a visible error and does not write state.

The `set_goal` tool exposes only `objective` and `replace` parameters.

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

Fork is the only start reason that inherits from `previousSessionFile`. When a
normal fork starts with a new session id and no current goal, the extension reads
the parent's `goal_json` and copies the parent's active goal into the fork's
metadata row. Subagent sessions are marked with `is_subagent` and do not inherit
parent goals.

## Automatic Continuation

The extension listens for `agent_end`. If a goal is active, incomplete, the
agent is idle, and there are no pending messages, the extension increments
`continuationTurns` and sends:

```text
Continue working toward this objective until it is achieved: <objective>
```

Continuation stops without sending a message when:

- the goal has `completedAt`;
- pending messages exist;
- the last assistant response was empty.

When an empty response stops continuation, Pi shows a warning explaining the stop reason.

## Completion Tool

The extension registers `goal_complete`. Calling it marks the active goal
complete by writing `completedAt` and `completionReason`, notifies the UI, and
returns a short text result. If no active goal exists, it returns "No active goal
to complete."

Completed goals do not trigger automatic continuation.

## Tests

`packages/coding-agent/test/goal-extension.test.ts` covers the implemented
behavior: first-party registration, set/view/clear, explicit replacement,
objective length rejection, prompt injection, continuation state without budget
lines, footer status, session-start restore notifications, fork-only goal
inheritance, corrupt state handling, automatic continuation, busy guard,
`goal_complete`, per-session isolation, budget flag rejection, and legacy budget
field ignorance.
