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
- `pausedAt`: timestamp set by an explicit pause action.
- `pauseReason`: concrete reason supplied to `manage_goal pause`, or `Paused by user.` for `/goal pause`.
- `reviewEvidence`: ordered unconsumed events from non-extension user input and successful `end_turn` calls, represented as `{ kind: "user", text }` or `{ kind: "end_turn", reason }`.

Missing state means no active goal. Corrupt JSON is also treated as no active
goal; the command and prompt hook do not throw.

## Slash Command

`/goal` is registered by the extension as a normal Pi slash command.

`/goal set <objective>` creates or replaces a goal, persists it, and notifies the UI.
Bare `/goal <text>` input is rejected so words such as `continue` cannot replace durable goal state.
Pi sends the unambiguous reminder for goal-start actions:

```text
Continue working toward the active goal.
```

`/goal set` starts that turn immediately when idle or queues it as a follow-up when busy, so the current turn completes without overlap and the newly set goal still starts another round. `manage_goal set` sends the same reminder when idle but does not queue a redundant generic follow-up during an active tool turn. `/goal resume` uses the same reminder when the session is idle. The interactive pending-follow-up preview renders this exact raw goal reminder as `Follow-up from goal: Continue working toward the active goal.` These reminders never restate the objective or `/goal set` syntax.

`/goal` with no arguments displays the current objective or a no-goal notice.

`/goal clear` clears the current session's `goal_json` metadata and reports whether anything was cleared.

A second `/goal set <objective>` replaces the active incomplete goal.

Objective text and production-created child prompts are limited to 10,000 characters. Longer objectives are rejected before state is written; longer child prompts are rejected before dispatch and child-session creation.

The command rejects flags with a visible error and does not write state. Removed budget flags keep specific error messages.

The `manage_goal` tool exposes an `action` parameter with optional `objective`,
pause-only `reason`, and `completionReport` parameters. It can set, pause, resume,
complete, clear, or view the current active goal. Pause requires a non-empty reason
and persists it with the pause timestamp. `/goal pause` uses the explicit reason
`Paused by user.`. Complete requires a nonblank free-form Markdown
`completionReport`; missing or blank reports fail locally before any Supervisor
request is created. The report is passed verbatim to `goal_completion_review`,
retained across wait/re-review, and stored as `completionReason` only after a
`complete` decision. The set action rejects reserved goal-control words such as
`continue`, preventing model-generated continuation instructions from becoming
objectives. Paused goals remain active and show their reason in `/goal`, startup
notifications, and footer status; legacy paused state without a reason shows
`No pause reason recorded`. They can be completed directly without resuming, but
do not inject prompt context or continue automatically until the resume action
removes both pause fields. Completion evidence is never inferred automatically.

`manage_goal set` is reviewed by the resident Supervisor before state changes. The
request includes the current objective when one exists and the proposed objective.
The Supervisor also preserves any known unfinished parent objective from shared
Supervisor context or KB memory. It must return a `set` decision whose objective
preserves every requirement, exclusion, and completion criterion from those parent
claims, then adds the proposal; only an explicit user instruction may reset or
narrow that parent. Before persistence, the extension collapses exact repeated copies of
the current objective so successive additive updates remain idempotent. Without
a current or known parent objective, it returns the proposal unchanged. A review error or stale
review leaves the existing goal state unchanged.

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

The extension shows the active objective on its own footer status line as
`goal: <objective>`. A paused goal instead shows `goal paused: <reason>`, keeping the stop reason visible. Other extension statuses remain grouped on their shared footer line. Setting, restoring, pausing, resuming, clearing, or completing a goal updates that status.

## Implementation inventory

- `packages/coding-agent/src/utils/footer-status.ts` — shared footer-status formatter that sanitizes values, groups non-goal statuses, and emits the `goal` status on its own line.
- `packages/coding-agent/extensions/default-footer/src/index.ts` — default-footer renderer that truncates each formatted extension-status line to the terminal width.
- `packages/coding-agent/src/modes/interactive/components/footer.ts` — core `FooterComponent` fallback that uses the shared formatter when no extension default footer replaces it.

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

The extension listens for `agent_end`. If a goal is active, incomplete, and there are no pending messages, a non-empty response requests `goal_idle_review` from the resident Supervisor. Before awaiting the decision, Pi appends `Waiting for Supervisor…`; resident reviews expire after 60 seconds. Each goal review receives the goal's unconsumed `reviewEvidence` as ordered `conversationEvents`; the legacy `terminalTurn` payload is not sent. Non-extension interactive or RPC user text and successful `end_turn` reasons are appended while the goal is running or explicitly paused. Failed `end_turn` calls, generated goal/Supervisor messages, other tool results, and status messages are excluded. Evidence remains stored through review errors, stale decisions, and cancellation, then is consumed only after an applied `complete`, `continue`, `wait`, or `pause` decision. `reviewEvidence` is cleared when a goal is replaced, completed, or cleared. Thrown review failures and timeout responses become durable reason-bearing status instead of ending silently. `continue` increments `continuationTurns` and submits the generic active-goal reminder when the agent can determine its own next step; it submits returned specific corrective instructions only for an evidence-backed omission, lost or narrowed scope, contradiction, repeated or circular work, or missing completion proof. `complete` closes the goal only when the full unfinished parent objective is proven; bounded objectives and progress reports are claims, not replacements for that parent. `wait` appends a durable Supervisor status entry, starts a cancellable background `wait_agent` when agents are active, and re-reviews after wake; without active agents it schedules the five-minute countdown and re-reviews, including when progress depends on an external condition that can be rechecked. `pause` is reserved for required user action or input that cannot advance automatically; it leaves the goal active without another turn and appends the reason. An aborted turn leaves the goal active and queues no continuation. An error turn schedules durable skipped-status output after the session becomes idle; a retry start or pending input cancels it, while retry exhaustion or cancellation emits it once. Aborted turns report `Goal continuation deferred: pending input will run next.` when pending input exists; otherwise they report `Goal continuation skipped: the model turn was aborted.`

A non-error empty assistant response no longer stops an active goal or emits the empty-response warning. It schedules a continuation check after 1 second and polls at 1-second intervals until the same goal remains active, the session is idle, and no messages are pending. Goal changes, pending input, and session shutdown cancel the polling.

### Supervisor wait countdown

When no active agents exist, the scheduler calculates one absolute five-minute `reviewAt` deadline and uses that same value for both the review timer and the durable `supervisor-status` entry. Interactive rendering derives `Next review in M:SS` from the deadline on each paint and switches to `Review due…` at expiry. A separate deadline-aligned refresher only requests UI redraws; it never appends entries, invokes Supervisor review, or changes the five-minute schedule.

Active-agent `wait_agent` statuses have no countdown because agent completion, not a timer, owns their wakeup. If agent discovery or `wait_agent` fails, the timed fallback persists its newly scheduled deadline. Input, new turns, goal changes, review start, session replacement, and shutdown clear redraw timers beside the existing review schedules. Resume restores redraw-only refresh from the newest future deadline but does not recreate a review timer, preventing duplicate Supervisor work.

Review does not start when:

- the goal has `completedAt` or is paused;
- pending messages exist;
- the last assistant response was empty.

Pending input is checked before abort handling. Interactive replacement input remains pending through `AgentSession.hasPendingMessages()` while its external-input reservation exists, even after the steering queue entry is consumed. A decision returned while pending state exists is retained and applied if that state drains without starting a turn. Input, a new turn, goal replacement/pause/completion/clear, or shutdown cancels deferred decisions, background waits, and review timers. Every asynchronous review rechecks goal identity before applying its decision. Scheduling or review failures append durable `supervisor-status` errors, keep the goal active, and use the same countdown when timed re-review remains scheduled. Aborted turns do not change persisted goal state or set `pausedAt`; only explicit pause actions set `pausedAt`.

## Completion Tool Action

Calling `manage_goal` with action `complete` requires a nonblank free-form
Markdown completionReport and requests `goal_completion_review` before changing
state, whether the active goal is running or paused. The review receives the same
ordered unconsumed `conversationEvents` as idle review, while the resident
Supervisor's own instructions are not re-sent because they already exist in its
persistent transcript. Missing or blank reports fail locally without creating a
Supervisor request. Pi appends `Waiting for Supervisor…` while the review is in
flight and passes the report verbatim; wait/re-review preserves the same report and
conversation evidence. `complete` writes `completedAt` and that report as
`completionReason`; `continue` keeps the goal active and submits the generic
active-goal reminder unless an evidence-backed exception requires a specific
corrective instruction; `wait` appends durable status and schedules agent wake or five-minute
re-review, including when progress depends on an external condition that can be
rechecked; `pause` is reserved for required user action or input that cannot advance
automatically, leaves the goal active without another continuation, and appends
`Goal waiting: <reason>`; rejected reports append durable status containing the
Supervisor reason; `error`, timeout, and thrown review failures leave the goal active
and report `Goal review failed: <reason>`. If no active goal exists, the tool returns
"No active goal to complete.". The system does not infer missing completion evidence.

Completed and paused goals do not trigger automatic continuation.

## Tests

`packages/coding-agent/test/goal-extension.test.ts` covers the implemented
behavior: first-party registration, explicit `/goal set`, bare-objective and reserved-control-word rejection, `manage_goal`, Supervisor-reviewed additive `manage_goal set`, view/clear, `/goal` replacement, removed replacement flag rejection, objective length rejection,
prompt injection, continuation state without budget lines, footer status,
session-start restore notifications, fork-only goal inheritance, corrupt state
handling, start-on-set follow-up scheduling, automatic continuation, ordered idle and completion conversation evidence, paused accumulation, generated/failed-event filtering, error/cancellation preservation, lifecycle clearing, deferred error-status cancellation, retry exhaustion and cancellation, empty-response polling and cancellation, per-session isolation, budget flag rejection, and legacy
budget field ignorance. `packages/coding-agent/test/default-footer-extension.test.ts` covers the default footer's dedicated goal status line and grouped non-goal statuses. `packages/coding-agent/test/footer-width.test.ts` covers the core `FooterComponent` fallback's dedicated goal status line and grouped non-goal statuses. `packages/coding-agent/test/suite/goal-extension-runtime.test.ts` verifies that `manage_goal set` during an active turn starts its queued follow-up round. `packages/coding-agent/test/supervisor-service.test.ts` verifies additive `goal_set_review` parsing and prompt instructions. Production child exclusion,
external-tool denial for spawned and attached sessions, inactive Pyrun calls,
supervisor retention, and no-continuation behavior are covered by
`packages/coding-agent/test/multi-agent-extension.test.ts`; the Architect policy
is covered by `packages/coding-agent/test/architect-service.test.ts`.
