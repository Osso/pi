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
- [x] Objectives longer than 4000 characters are rejected with a visible error and are not persisted; production child prompts are still validated before dispatch.
- [x] Removed budget flags (`--token-budget`, `--wall-clock-minutes`) and the replacement flag (`--replace`) are rejected with a visible error and are not persisted.
- [x] At most one active goal exists per session at a time; separate non-child sessions in the same project can have distinct active goals.
- [x] The active goal survives `session_start` with reason `resume`/`reload`/`fork` and is surfaced to the user from persisted state.
- [x] Normal forked sessions inherit the parent goal when no goal exists yet; production-created `spawn_agent`, `attach_session_agent`, and `/bg` runtimes do not load the goal extension.
- [x] Production-created `spawn_agent` child sessions validate non-empty prompts before dispatch, but do not seed goal state or load the goal extension; blank prompts are rejected without creating an agent record.
- [x] Production-created `attach_session_agent` runtimes do not seed or copy goal metadata; any existing `goal_json` remains inert because the goal extension is excluded.
- [x] Production-created `/bg` child jobs validate non-empty prompts before dispatch, but do not seed goal state or load the goal extension.
- [x] Corrupt or malformed goal JSON is handled as "no active goal" without crashing the command or turn hook.
- [x] Completed goals are not treated as active by `/goal`, startup notifications, continuation, or context injection.
- [x] Paused goals remain visible in `/goal`, startup notifications, and the footer, but do not inject context or continue automatically until `/goal resume` clears the paused state.
- [x] `/goal` is delivered from a tracked first-party extension package, not from
  project-local `.pi/extensions/` code.
- [x] A `manage_goal` tool can set, pause, resume, complete, clear, and view the active objective for tool-capability parity with `/goal` lifecycle actions.
- [x] The `manage_goal` tool exposes an action parameter plus optional objective and reason parameters.
- [x] Supervisor-only capability filtering removes every tool named `manage_goal` from production `spawn_agent`, `attach_session_agent`, and `/bg` runtimes even when an external extension registers it; the supervisor retains the tool.
- [x] Calls to denied `manage_goal` tools fail as inactive, including calls issued through the Pyrun `pi.tools.call` bridge.

### Context anchoring

- [x] Before each agent turn, the active objective is injected into the system prompt through `before_agent_start`.
- [x] The injected block tells the model to keep working toward the objective until achieved, and to report blockers instead of stopping silently.
- [x] Goal context includes the current continuation state when autonomous continuation is active.

### Starting and continuing work

- [x] Setting a goal while the session is idle immediately submits a user message that asks the agent to work toward the objective.
- [x] When an `agent_end` event fires and a goal is active, not paused, and not completed, Pi re-submits a continuation message unless a continuation stop condition applies.
- [x] If the last assistant message has `stopReason: "error"`, goal continuation neither queues a follow-up nor emits the empty-response warning; retry/session error handling owns recovery and leaves the active goal intact.
- [x] The `manage_goal` completion action marks the active goal complete and stops further continuation.
- [x] Autonomous continuation has no numeric turn cap; it may run for long-lived goals until completion, pending queued work, or a non-error empty final assistant response stops it.
- [x] Continuation does not start a second overlapping turn while the agent is already busy.
- [x] Goal start/resume/continuation messages remain in live model context and transcript rendering, but do not appear in the editor's typed prompt history.
- [x] Compaction excludes goal-generated start/resume/continuation reminders from summarization input while preserving other extension-origin messages and the original session log.

## How it works

- `docs/wiki/systems/goal-system.md`.
- Builds on the native context-injection contract — see [`prompt-context-hooks.md`](prompt-context-hooks.md).
- Builds on the native lifecycle events — see [`session-lifecycle-hooks.md`](session-lifecycle-hooks.md).
- Uses the control SQLite `session_metadata` row for transparent, per-session state. The same row stores `goal_json`, `is_subagent`, and `subagent_name` alongside the session display name metadata.
- One-time migration reads existing project-local `.pi/goal.json` and `.pi/goals/<session-id>.json` state into the session metadata row and removes the migrated legacy file.

## Implementation inventory

- `packages/coding-agent/extensions/goal/src/index.ts` — first-party extension entry: registers `/goal`, registers `manage_goal`, persists goal JSON through the session manager into `session_metadata.goal_json`, injects active unpaused goals through `before_agent_start`, shows the active goal in the footer status, starts work when a goal is set while idle, pauses/resumes goals on request, and continues active unpaused goals from `agent_end`.
- `packages/coding-agent/src/core/tool-capabilities.ts` — defines the supervisor-only tool capability list used by non-supervisor runtimes.
- `packages/coding-agent/extensions/agents-core/src/runtime.ts` — excludes supervisor-only tools from spawned and attached child session factories while preserving first-party goal-extension filtering.
- `packages/coding-agent/src/architect/main.ts` — excludes supervisor-only tools from the resident Architect service.
- `packages/coding-agent/extensions/goal/package.json` — workspace metadata for the first-party goal extension package.
- `package.json` / `package-lock.json` — include the goal extension as a reviewed workspace package.
- `packages/coding-agent/test/goal-extension.test.ts` — regression coverage for first-party extension delivery, `manage_goal`, set/view/pause/resume/clear, per-session goal isolation, default replacement, objective length cap, context injection, continuation prompt state, footer status, start-on-set behavior, resume/reload/fork notification, corrupt/malformed goal state handling, completed-goal inactivity, `agent_end` continuation, busy guard, error-stop suppression, no numeric turn cap, empty-response stop, budget flag rejection, legacy budget field ignorance, and removed replacement flag rejection.
- `packages/coding-agent/test/suite/regressions/goal-messages-prompt-history.test.ts` — extension-origin goal messages remain excluded from editor prompt-history population.
- `packages/coding-agent/test/compaction.test.ts` — goal reminders are excluded from compaction summarization input without removing unrelated extension messages.
- `.gitignore` — ignores legacy `.pi/goals/` local goal state files during migration.

## Tests asserting this spec

- `packages/coding-agent/test/goal-extension.test.ts` — first-party extension delivery, `manage_goal`, `/goal` set/view/pause/resume/clear, per-session goal isolation, default replacement, removed replacement flag rejection, objective length cap, context injection, continuation prompt state, footer status, immediate start-on-set behavior, resume/reload/fork notification, corrupt/malformed goal state handling, completed-goal inactivity, `agent_end` continuation, busy guard, error-stop suppression, no numeric turn cap, empty-response stop, budget flag rejection, and legacy budget field ignorance.
- `packages/coding-agent/test/multi-agent-extension.test.ts` — production child prompt validation, absence of child goal state, exclusion of the goal extension from child sessions, supervisor-only `manage_goal` denial for spawned and attached children, Pyrun bridge denial, supervisor retention, and absence of goal continuation injection on child completion.
- `packages/coding-agent/test/architect-service.test.ts` — resident Architect supervisor-only tool exclusion policy.
- `packages/coding-agent/test/session-control-db.test.ts` — control SQLite metadata coverage for `goal_json`, `is_subagent`, and `subagent_name` columns.

## Known gaps (current cycle)

- [x] Add regression coverage for resume/session_start notification and corrupt goal-state handling.
- [x] Replace the active goal by default when setting a new goal while one is already active.
- [x] Implement autonomous continue-when-idle on `agent_end`.
- [x] Add a tool completion signal and stop continuation when it is called.
- [x] Remove numeric continuation turn-cap handling and stop only on completion, pending queued work, or a non-error empty final assistant response.
- [x] Move `/goal` from project-local `.pi/extensions/goal.ts` into a first-party tested extension path, or document why project-local loading is the intended delivery path.
- [x] Write `docs/wiki/systems/goal-system.md`.

## Out of scope

- Deploy/test/lint/coverage/Sentry acceptance gates. Those belong to project-specific workflows and skills, not to codex-style `/goal`.
- Multi-goal stacks or cross-project goals — one active goal per session for now.
- Automatic remediation — continuation keeps working toward the objective, but the goal system itself does not fix failed work.
- Goal behavior for ordinary sessions and normal forks remains in scope. Production-created `spawn_agent` children, `attach_session_agent` runtimes, and `/bg` jobs have no goal extension, goal commands/tools, prompt injection, footer status, or autonomous continuation. Attached sessions may retain pre-existing `goal_json`, but the child runtime does not interpret it.
