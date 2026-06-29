# Goal System

The goal system is implemented as a first-party coding-agent extension in
`packages/coding-agent/extensions/goal/`. It provides `/goal` plus a
`goal_complete` tool, persists one active objective per working directory, and
keeps that objective in the system prompt until it is completed or continuation
is stopped by configured bounds.

The contract lives in `docs/specs/goal-system.md`.

## State

Goal state is stored in `.pi/goal.json` under the command context working
directory. The file is JSON, formatted with two-space indentation and a trailing
newline, so it can be inspected or edited directly. Local goal state is ignored
by git.

The persisted record contains:

- `objective`: the active goal text.
- `branch`: the git branch when the goal was created, or `(no branch)` if branch
  lookup fails.
- `createdAt`: ISO timestamp for creation.
- `completedAt` and `completionReason`: set when `goal_complete` marks the goal
  complete.
- `continuationTurns`: number of automatic continuation turns already sent.
- `tokenBudget`: token ceiling. New goals default to 1,000,000,000 unless an explicit budget is provided.
- `wallClockBudgetMs`: optional wall-clock ceiling.

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

`/goal clear` removes `.pi/goal.json` and reports whether anything was cleared.

`/goal --replace <objective>` replaces an active, incomplete goal. Without
`--replace`, a second objective is rejected while an incomplete goal exists.

Objective text is limited to 4000 characters. Longer objectives are rejected
before state is written.

The command also accepts:

- `--token-budget <positive integer>` (defaults to 1,000,000,000)
- `--wall-clock-minutes <positive integer>`

Invalid or missing budget values produce an error notification and do not write
state.

## Prompt Injection

The extension listens for `before_agent_start`. When an active goal exists, it
appends a `<goal>` block to the assembled system prompt. The block includes the
objective, branch, creation timestamp, continuation turns, and any configured
budgets.

The injected instructions tell the model to keep working until the goal is
achieved and to report blockers instead of stopping silently.

## Footer Status

The extension shows the active objective in the footer status line as
`goal: <objective>`. Setting, restoring, clearing, or completing a goal updates
that status.

## Session Start

The extension listens for `session_start`. If `.pi/goal.json` contains a goal,
Pi notifies the user with the restored objective and shows it in the footer. The
same restore behavior is covered for resume, reload, and fork reasons.

## Automatic Continuation

The extension listens for `agent_end`. If a goal is active, incomplete, the
agent is idle, and there are no pending messages, the extension increments
`continuationTurns` and sends:

```text
Continue working toward this objective until it is achieved: <objective>
```

Continuation stops without sending a message when:

- the goal has `completedAt`;
- the agent is not idle;
- pending messages exist;
- `continuationTurns` has reached the cap of 8;
- current context usage reaches `tokenBudget`;
- elapsed wall-clock time reaches `wallClockBudgetMs`.

When a budget or turn cap stops continuation, Pi shows a warning explaining the
stop reason.

## Completion Tool

The extension registers `goal_complete`. Calling it marks the active goal
complete by writing `completedAt` and `completionReason`, notifies the UI, and
returns a short text result. If no active goal exists, it returns "No active goal
to complete."

Completed goals do not trigger automatic continuation.

## Tests

`packages/coding-agent/test/goal-extension.test.ts` covers the implemented
behavior: first-party registration, set/view/clear, explicit replacement,
objective length rejection, prompt injection, continuation state and budgets,
footer status, session-start restore notifications, corrupt state handling,
automatic continuation, busy guard, `goal_complete`, turn cap, token budget, and
wall-clock budget.
