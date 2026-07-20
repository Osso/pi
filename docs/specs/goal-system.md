# Goal System (`/goal`)

Module boundary: first-party extension module (`packages/coding-agent/extensions/goal/`), with only generic extension/runtime support in core.

The goal system keeps a long-running objective active across turns and resumed sessions. A
goal is a plain objective string, not a deploy gate checklist. It is persisted in the
session's control SQLite metadata row, injected into the model context before each turn, and
used to keep the agent working until the objective is explicitly completed or a continuation
stop condition is reached. How it works belongs in `docs/wiki/systems/goal-system.md`.

## What it must do

### Goal lifecycle

- [x] `/goal set <objective>` creates or replaces the active objective for the current session and persists it to the session's `session_metadata.goal_json` row in the control SQLite database. Bare `/goal <text>` input is rejected so continuation words cannot become durable objectives.
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
- [x] A `manage_goal` tool can set, pause, resume, complete, clear, and view the active objective for tool-capability parity with `/goal` lifecycle actions; completion accepts paused active goals without requiring resume, and set rejects reserved goal-control words such as `continue`.
- [x] The `manage_goal` tool exposes an action parameter plus optional objective and reason parameters.
- [x] Supervisor-only capability filtering removes every tool named `manage_goal` from production `spawn_agent`, `attach_session_agent`, and `/bg` runtimes even when an external extension registers it; the supervisor retains the tool.
- [x] Calls to denied `manage_goal` tools fail as inactive, including calls issued through the Pyrun `pi.tools.call` bridge.

### Context anchoring

- [x] Before each agent turn, the active objective is injected into the system prompt through `before_agent_start`.
- [x] The injected block tells the model to keep working toward the objective until achieved, and to report blockers instead of stopping silently.
- [x] Goal context includes the current continuation state when autonomous continuation is active.

### Starting and continuing work

- [x] Setting a goal or resuming a paused goal while the session is idle submits exactly `Continue working toward the active goal.`; generated user messages never restate goal-setting syntax or objective text.
- [x] When an `agent_end` event fires for a running goal, Pi checks pending input before abort, error-stop, and empty-response handling; non-error empty assistant responses schedule one continuation after a 1-second bounded delay only if the same goal remains active, the session remains idle, and no messages are pending, while other eligible responses request resident Supervisor review.
- [x] Empty-response continuation timers are canceled during session shutdown.
- [x] Agent aborts never persist paused state, including restart teardown and steering replacement; only explicit `/goal pause` or `manage_goal pause` actions may pause a goal.
- [x] Goal continuation rechecks queued steering and follow-up input before and after asynchronous Supervisor review; initial transient pending state retries review after input drains, while input queued during review runs before any later continuation, does not increment the continuation counter, and preserves the reviewed decision until the session becomes idle or the schedule is canceled.
- [x] If the last assistant message has `stopReason: "error"`, goal continuation neither queues a follow-up nor emits the empty-response warning; retry/session error handling owns recovery and leaves the active goal intact.
- [x] The `manage_goal` completion action requests resident Supervisor review for active goals, including paused goals; `complete` marks the goal complete, `continue` keeps it active with concrete next-step instructions, `wait` appends a durable Supervisor status entry and keeps it active without duplicate work, and `pause` leaves it active without scheduling another turn.
- [x] Autonomous continuation has no numeric turn cap; a Supervisor `continue` decision submits actionable instructions as a visible `supervisor` custom follow-up wrapped in explicit Supervisor provenance for model context, while its renderer shows one `[Supervisor]` header and a plain instruction body without exposing the XML wrapper; `complete` closes the goal; `wait` or idle-review `error` appends durable status, calls `wait_agents` when agents are active, and re-runs Supervisor review after agent wake or five minutes; only `pause` stops automatic continuation without changing active/paused persistence.
- [x] Continuation does not start a second overlapping turn while the agent is already busy.
- [x] Goal start/resume/continuation messages remain unchanged in persisted transcript and live model context; Supervisor XML provenance is hidden only by TUI rendering, and generated messages do not appear in the editor's typed prompt history.
- [x] Compaction excludes goal-generated start/resume/continuation reminders from summarization input while preserving other extension-origin messages and the original session log.

## How it works

- `docs/wiki/systems/goal-system.md`.
- Builds on the native context-injection contract — see [`prompt-context-hooks.md`](prompt-context-hooks.md).
- Builds on the native lifecycle events — see [`session-lifecycle-hooks.md`](session-lifecycle-hooks.md).
- Uses the control SQLite `session_metadata` row for transparent, per-session state. The same row stores `goal_json`, `is_subagent`, and `subagent_name` alongside the session display name metadata.
- One-time migration reads existing project-local `.pi/goal.json` and `.pi/goals/<session-id>.json` state into the session metadata row and removes the migrated legacy file.

## Implementation inventory

- `packages/coding-agent/extensions/goal/src/index.ts` — first-party extension entry: registers `/goal` and goal lifecycle hooks, persists goal state, injects active objectives, and coordinates Supervisor decisions.
- `packages/coding-agent/extensions/goal/src/goal-scheduling.ts` — preserves decisions across transient pending input, waits for active agents, and schedules five-minute Supervisor re-review.
- `packages/coding-agent/extensions/goal/src/completion-scheduling.ts` — preserves completion-review evidence and decision type across wait wakeups.
- `packages/coding-agent/extensions/goal/src/empty-response-scheduling.ts` — owns bounded empty-response retry timers.
- `packages/coding-agent/extensions/goal/src/goal-tool.ts` — registers and types `manage_goal`.
- `packages/coding-agent/extensions/goal/src/rendering.ts` — preserves tagged Supervisor model content while rendering one visible `[Supervisor]` header and plain instruction body.
- `packages/coding-agent/extensions/goal/src/goal-args.ts` — parses supported `/goal` command actions and rejects removed flags.
- `packages/coding-agent/src/core/tool-capabilities.ts` — defines the supervisor-only tool capability list used by non-supervisor runtimes.
- `packages/coding-agent/extensions/agents-core/src/runtime.ts` — excludes supervisor-only tools from spawned and attached child session factories while preserving first-party goal-extension filtering.
- `packages/coding-agent/src/architect/main.ts` — excludes supervisor-only tools from the resident Architect service.
- `packages/coding-agent/extensions/goal/package.json` — workspace metadata for the first-party goal extension package.
- `package.json` / `package-lock.json` — include the goal extension as a reviewed workspace package.
- `packages/coding-agent/test/goal-extension.test.ts` — regression coverage for first-party extension delivery, explicit `/goal set`, bare-objective rejection, reserved control-word rejection, `manage_goal`, paused-goal completion, view/pause/resume/clear, per-session goal isolation, replacement, objective length cap, context injection, continuation prompt state, footer status, start-on-set behavior, resume/reload/fork notification, corrupt/malformed goal state handling, completed-goal inactivity, `agent_end` continuation, queued steering and aborts preserving the running goal, queued input arriving during Supervisor review, busy and pending-input guards, error-stop suppression, no numeric turn cap, empty-response retry eligibility and shutdown cancellation, budget flag rejection, legacy budget field ignorance, and removed replacement flag rejection.
- `packages/coding-agent/test/suite/headless-supervisor-systems.test.ts` — real-process coverage that active goals remain active across restart and Supervisor wait decisions while explicit paused state survives restart byte-for-byte.
- `packages/coding-agent/test/suite/regressions/goal-messages-prompt-history.test.ts` — extension-origin goal messages remain excluded from editor prompt-history population.
- `packages/coding-agent/test/compaction.test.ts` — goal reminders are excluded from compaction summarization input without removing unrelated extension messages.
- `.gitignore` — ignores legacy `.pi/goals/` local goal state files during migration.

## Tests asserting this spec

- `packages/coding-agent/test/goal-extension.test.ts` — first-party extension delivery, `manage_goal`, `/goal` set/view/pause/resume/clear, per-session goal isolation, default replacement, removed replacement flag rejection, objective length cap, context injection, continuation prompt state, footer status, immediate start-on-set behavior, resume/reload/fork notification, corrupt/malformed goal state handling, completed-goal inactivity, `agent_end` continuation, queued steering versus abort-only pause behavior, busy guard, error-stop suppression, no numeric turn cap, empty-response retry eligibility and shutdown cancellation, budget flag rejection, and legacy budget field ignorance.
- `packages/coding-agent/test/multi-agent-extension.test.ts` — production child prompt validation, absence of child goal state, exclusion of the goal extension from child sessions, supervisor-only `manage_goal` denial for spawned and attached children, Pyrun bridge denial, supervisor retention, and absence of goal continuation injection on child completion.
- `packages/coding-agent/test/architect-service.test.ts` — resident Architect supervisor-only tool exclusion policy.
- `packages/coding-agent/test/session-control-db.test.ts` — control SQLite metadata coverage for `goal_json`, `is_subagent`, and `subagent_name` columns.

## Known gaps (current cycle)

- [x] Add regression coverage for resume/session_start notification and corrupt goal-state handling.
- [x] Replace the active goal by default when setting a new goal while one is already active.
- [x] Implement autonomous continue-when-idle on `agent_end`.
- [x] Add a tool completion signal and stop continuation when it is called.
- [x] Remove numeric continuation turn-cap handling and stop only on completion or pending queued work; non-error empty final assistant responses schedule one bounded retry when the goal remains eligible.
- [x] Move `/goal` from project-local `.pi/extensions/goal.ts` into a first-party tested extension path, or document why project-local loading is the intended delivery path.
- [x] Write `docs/wiki/systems/goal-system.md`.

## Out of scope

- Deploy/test/lint/coverage/Sentry acceptance gates. Those belong to project-specific workflows and skills, not to codex-style `/goal`.
- Multi-goal stacks or cross-project goals — one active goal per session for now.
- Automatic remediation — continuation keeps working toward the objective, but the goal system itself does not fix failed work.
- Goal behavior for ordinary sessions and normal forks remains in scope. Production-created `spawn_agent` children, `attach_session_agent` runtimes, and `/bg` jobs have no goal extension, goal commands/tools, prompt injection, footer status, or autonomous continuation. Attached sessions may retain pre-existing `goal_json`, but the child runtime does not interpret it.
