# Goal System (`/goal`)

Module boundary: first-party extension module (`packages/coding-agent/extensions/goal/`), with only generic extension/runtime support in core.

The goal system keeps a long-running objective active across turns and resumed sessions. A
goal is a plain objective string, not a deploy gate checklist. It is persisted in the
session's control SQLite metadata row, injected into the model context before each turn, and
used to keep the agent working until the objective is explicitly completed or a continuation
stop condition is reached. How it works belongs in `docs/wiki/systems/goal-system.md`.

## What it must do

### Goal lifecycle

- [x] `/goal <objective>` replaces the active objective for the current session by default and persists it to the session's `session_metadata.goal_json` row in the control SQLite database.
- [x] `/goal` prints the active objective, or a visible notice when no goal is active.
- [x] `/goal pause` suspends context injection and autonomous continuation without clearing the objective.
- [x] `/goal resume` resumes a paused objective without replacing it.
- [x] `/goal clear` removes the active objective.
- [x] Objectives longer than 4000 characters are rejected with a visible error and are not persisted, including `spawn_agent` prompts that seed production child goals.
- [x] Removed budget flags (`--token-budget`, `--wall-clock-minutes`) and the replacement flag (`--replace`) are rejected with a visible error and are not persisted.
- [x] At most one active goal exists per session at a time; separate sessions and subagents in the same project can have distinct active goals.
- [x] The active goal survives `session_start` with reason `resume`/`reload`/`fork` and is surfaced to the user from persisted state.
- [x] Normal forked sessions inherit the parent goal when no goal exists yet; subagent sessions do not inherit the parent goal and may set an independent goal.
- [x] Production-created `spawn_agent` child sessions receive a fresh, non-empty session-local goal from the trimmed prompt before their first model turn; blank `spawn_agent` prompts are rejected without creating an agent record.
- [x] Production-created `/bg` child jobs receive a fresh, non-empty session-local goal from the trimmed background prompt before their first model turn.
- [x] Corrupt or malformed goal JSON is handled as "no active goal" without crashing the command or turn hook.
- [x] Completed goals are not treated as active by `/goal`, startup notifications, continuation, or context injection.
- [x] Paused goals remain visible in `/goal`, startup notifications, and the footer, but do not inject context or continue automatically until `/goal resume` clears the paused state.
- [x] `/goal` is delivered from a tracked first-party extension package, not from
  project-local `.pi/extensions/` code.
- [x] A `manage_goal` tool can set, pause, resume, complete, clear, and view the active objective for tool-capability parity with `/goal` lifecycle actions.
- [x] The `manage_goal` tool exposes an action parameter plus optional objective and reason parameters.

### Context anchoring

- [x] Before each agent turn, the active objective is injected into the system prompt through `before_agent_start`.
- [x] The injected block tells the model to keep working toward the objective until achieved, and to report blockers instead of stopping silently.
- [x] Goal context includes the current continuation state when autonomous continuation is active.

### Starting and continuing work

- [x] Setting a goal while the session is idle immediately submits a user message that asks the agent to work toward the objective.
- [x] When an `agent_end` event fires and a goal is active, not paused, and not completed, Pi re-submits a continuation message.
- [x] The `manage_goal` completion action marks the active goal complete and stops further continuation.
- [x] Autonomous continuation has no numeric turn cap; it may run for long-lived goals until completion, pending queued work, or an empty final assistant response stops it.
- [x] Continuation does not start a second overlapping turn while the agent is already busy.

## How it works

- `docs/wiki/systems/goal-system.md`.
- Builds on the native context-injection contract — see [`prompt-context-hooks.md`](prompt-context-hooks.md).
- Builds on the native lifecycle events — see [`session-lifecycle-hooks.md`](session-lifecycle-hooks.md).
- Uses the control SQLite `session_metadata` row for transparent, per-session state. The same row stores `goal_json`, `is_subagent`, and `subagent_name` alongside the session display name metadata.
- One-time migration reads existing project-local `.pi/goal.json` and `.pi/goals/<session-id>.json` state into the session metadata row and removes the migrated legacy file.

## Implementation inventory

- `packages/coding-agent/extensions/goal/src/index.ts` — first-party extension entry: registers `/goal`, registers `manage_goal`, persists goal JSON through the session manager into `session_metadata.goal_json`, injects active unpaused goals through `before_agent_start`, shows the active goal in the footer status, starts work when a goal is set while idle, pauses/resumes goals on request, and continues active unpaused goals from `agent_end`.
- `packages/coding-agent/extensions/goal/package.json` — workspace metadata for the first-party goal extension package.
- `package.json` / `package-lock.json` — include the goal extension as a reviewed workspace package.
- `packages/coding-agent/test/goal-extension.test.ts` — regression coverage for first-party extension delivery, `manage_goal`, set/view/pause/resume/clear, per-session and subagent goal isolation, default replacement, objective length cap, context injection, continuation prompt state, footer status, start-on-set behavior, resume/reload/fork notification, corrupt/malformed goal state handling, completed-goal inactivity, `agent_end` continuation, busy guard, no numeric turn cap, empty-response stop, budget flag rejection, legacy budget field ignorance, and removed replacement flag rejection.
- `.gitignore` — ignores legacy `.pi/goals/` local goal state files during migration.

## Tests asserting this spec

- `packages/coding-agent/test/goal-extension.test.ts` — first-party extension delivery, `manage_goal`, `/goal` set/view/pause/resume/clear, per-session and subagent goal isolation, default replacement, removed replacement flag rejection, objective length cap, context injection, continuation prompt state, footer status, immediate start-on-set behavior, resume/reload/fork notification, corrupt/malformed goal state handling, completed-goal inactivity, `agent_end` continuation, busy guard, no numeric turn cap, empty-response stop, budget flag rejection, and legacy budget field ignorance.
- `packages/coding-agent/test/session-control-db.test.ts` — control SQLite metadata coverage for `goal_json`, `is_subagent`, and `subagent_name` columns.

## Known gaps (current cycle)

- [x] Add regression coverage for resume/session_start notification and corrupt goal-state handling.
- [x] Replace the active goal by default when setting a new goal while one is already active.
- [x] Implement autonomous continue-when-idle on `agent_end`.
- [x] Add a tool completion signal and stop continuation when it is called.
- [x] Remove numeric continuation turn-cap handling and stop only on completion, pending queued work, or empty final assistant response.
- [x] Move `/goal` from project-local `.pi/extensions/goal.ts` into a first-party tested extension path, or document why project-local loading is the intended delivery path.
- [x] Write `docs/wiki/systems/goal-system.md`.

## Out of scope

- Deploy/test/lint/coverage/Sentry acceptance gates. Those belong to project-specific workflows and skills, not to codex-style `/goal`.
- Multi-goal stacks or cross-project goals — one active goal per session for now.
- Automatic remediation — continuation keeps working toward the objective, but the goal system itself does not fix failed work.
- Goal seeding outside production-created child sessions: externally supplied dispatchers, store-only agent records, and attached/resumed sessions preserve their existing lifecycle semantics. `/bg` child jobs are production-created child sessions and are included.
