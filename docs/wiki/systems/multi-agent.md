# Multi-agent System

This page records the current design direction for Pi's native multi-agent system. The spec
contract lives in [`docs/specs/multi-agent.md`](../../specs/multi-agent.md).

## Current state

Pi now uses `LifecycleCoordinator` as the sole control-plane lifecycle authority. Coordinator
commands commit through exact process-owner control-DB transactions, while `MultiAgentStore` projects
committed agent/mailbox state for tools and UI. Detached Bash and Pyrun runners directly finalize from
in-memory identity, outcome, and output metadata; output artifacts are diagnostic only. Child-session
dispatch, attached-session recovery, cancellation, steering, and waits use the same repository authority.

The first-party agent extensions expose `agent_viewer`, `spawn_agent`, `list_agents`, `wait_agents`,
`cancel_agent`, `contact_parent`, `send_agent_message`, and `steer_agent`. Orchestration-capable
main runtimes must receive an issued execution capability before these tools or main-runtime listeners
are exposed. `spawn_agent` constructs executable child work before persistence: success stores `running`
revision 1, while construction interruption or failure stores `failed` revision 1. Promptless saved-session
attachment is a separate operation. Production has no optional dispatcher or dormant-row fallback.
`list_agents` always returns active agents and can scope results to descendants below a parent ID, using core store state rather than rendered TUI rows. Terminal agents remain inspectable by ID through `agent_viewer`. `contact_parent` is direct-parent-only: the caller's exact runtime identity
`(session_id, agent_id)` must match the sending row, persisted `parent_request` rows must target that row's
current direct parent, parentless runtimes are rejected, and the tool cannot target the resident Supervisor
or an arbitrary sibling. The old `contact_supervisor` name has no compatibility alias.
Mailbox messages can carry validated absolute `fileRefs` entries with
optional labels, so logs and diffs remain direct file references rather than registry records.
`wait_agents({})` consumes every pending terminal notification already waiting, then queries current agent
rows for agents active at invocation until one is terminal. On a coordination wake, it instead returns and consumes
all currently pending deliverable runtime-mailbox and shared-channel inputs, preserving sender/body formatting;
mailbox rows become `delivered` and the shared-channel cursor advances. Each distinct coordination message is visible
exactly once. The agent row remains terminal truth, and Pyrun `pi.agents.wait()` uses the same semantics.
The store also supports revision-checked pinned slot updates while preserving stable metadata and
lifecycle state. `getProjectionSnapshot()` returns copied agent/mailbox/slot projections so UI
surfaces can resync from core state by agent ID instead of trusting stale rendered rows.
`send_agent_message` creates direct mailbox messages only across one immediate parent-child edge, so
siblings and transitive ancestors or descendants cannot target each other directly.
`agent_viewer` is read-only, requires an agent ID, and returns one agent's snapshot, status,
transcript pointer, child IDs, and stop/steer command descriptors; those descriptors name existing
tools and do not mutate agent lifecycle by themselves.
Higher-level workflow extensions must invoke the registered agent tools or Pyrun request handler;
they cannot create dormant agent rows or call store lifecycle mutators. Coordinator child creation
inherits parent model/account budget metadata and rejects permission broadening.
Production child sessions also resolve agent-type profiles from settings. The built-in profiles are
`explore` (`openai/gpt-5-mini`, low thinking), `verifier` (`openai/gpt-5-mini`, low thinking),
`implement` (`openai/gpt-5.5`, medium thinking), and `reviewer` (`openai/gpt-5.5`, medium
thinking). User settings can override them with `agents.<type>.model` and
`agents.<type>.thinkingLevel`.

`spawn_agent` requires an explicit `context`: `fresh` creates a new child transcript with only the
assignment appended, while `inherit` forks a persisted parent transcript, copies its prior entries,
and then appends the assignment without changing the parent. If the parent has no persisted session
file, `inherit` rejects the request instead of changing semantics. Direct callers choose `inherit` when prior main-thread
decisions or research are required; they choose `fresh` for isolated work, review, verification, or
falsification. `/bg` and restart recovery select `fresh` internally. `attach_session_agent` reuses an
existing transcript and does not use this context choice.

Model execution guidance and verifier proof scope are specified in the
[model execution and proof contract](../../specs/multi-agent.md#model-execution-and-proof): known
independent tool calls are emitted together, while dependent calls wait for their inputs, and
applicable command and artifact verification checks form one proof union.

## Runtime ownership and recovery

The supervisor is the only orchestration authority. Child runtimes register only their agent-address
mailbox listener, never a same-PID main listener, and never run supervisor-wide persisted-store
reconciliation. Their initialized session-start hook reconciles only direct persisted descendants through
coordinator recovery. They also reject direct `spawn_agent`, `attach_session_agent`, and `wait_agents`
calls, the equivalent Pyrun bridge methods, and `/bg`; production child sessions exclude
those tools as a second boundary.

At supervisor start, there are no persisted `queued` or `starting` startup rows. Child construction
happens first; successful construction persists `running` revision 1, while interruption or failure
persists `failed` revision 1. After the `running` commit, the parent session appends an `agent_start`
custom JSONL record containing the agent ID and child transcript identity. A committed `completed`,
`failed`, or `aborted` transition appends the matching `agent_complete` record. Unmatched starts are
the authoritative restart candidates; matching completions prevent recovery. Control-DB lifecycle and
ownership rows remain required, but cannot admit child recovery without the parent record. There is no
control-DB-only fallback. Detached Bash and Pyrun jobs retain their separate tool-call JSONL and runner
recovery contract and do not use these child-agent records. After the one registered supervisor binding
for the session path registers, that supervisor reconstructs eligible active children through coordinator
recovery commands while preserving agent and transcript identity.
Runtime ownership is the exact Linux process identity `(pid, /proc/<pid>/stat startTimeTicks)`; recovery
occurs only after that exact identity is gone and never rewrites lifecycle JSON directly.
The one registered supervisor binding persists that exact process identity for its asserted session path.
If a new Pi runtime reuses the same PID, registration advances the inventory-only session health generation
without mutating lifecycle rows. A different PID cannot
replace the binding while its predecessor is still verified as a live Pi runtime. Inventory tools never create listener bindings or
write caller PID health; only the runtime listener lifecycle owns those rows. Heartbeat freshness
alone is not PID ownership: inventory preserves uncertain live processes to avoid unsafe mutation,
while mailbox wakeups require verified Pi command ownership before signalling.
The path assertion is trusted only while its assertion
timestamp matches the listener heartbeat; pathless or legacy timestamp-only heartbeats invalidate it.
Session-path relocation moves the assertion in the same transaction as the store. Verified
administrative shutdown/restart may terminalize owned work through an exact-owner coordinator command.
Confirmed exact owner-process exit records `failed/lost_runtime` from `running` or
`aborted/lost_runtime` from `cancelling`, while attached, terminal, current-live, and uncertain
process-backed rows follow their explicit recovery policies. Runtime-process verification recognizes
Pi executables and source, Bun, or built `packages/coding-agent` entrypoints in relative or absolute form.
Startup reconciliation scans persisted detached runtimes after listener/path binding, including exact
dead runners whose logical parent session remains live. Attached-session rows retain the transcript-backed
resume path; attached rows already waiting for input remain idle.

`wait_agents({})` takes no agent ID. Each invocation snapshots active agents and consumes every pending terminal
notification already waiting, then polls authoritative control-DB agent rows until one snapshot member is terminal.
A coordination wake returns and consumes all currently pending deliverable runtime-mailbox and shared-channel inputs,
preserving sender/body formatting; mailbox rows become `delivered` and the shared-channel cursor advances. Each
distinct coordination message is visible exactly once. Terminal notifications still accelerate the agent-row query,
so a detached runner in another process can wake a blocked wait after its terminal commit. The store removes transient
worker metadata on restore, but durable lifecycle state remains unchanged until an exact-owner command commits.

Existing primitives worth reusing:

- `packages/coding-agent/src/core/agent-session.ts` owns one live agent session, prompt steering,
  follow-up queues, tool approval, abort, compaction, and extension binding.
- `packages/coding-agent/src/core/session-manager.ts` already persists JSONL session headers,
  `parentSession`, tree entries, custom entries, custom message entries, and branch context.
- `packages/coding-agent/src/core/extensions/types.ts` exposes commands, tools, shortcuts,
  message renderers, lifecycle hooks, and command actions such as `newSession`, `fork`,
  `switchSession`, and `reload`.
- `packages/coding-agent/src/core/permissions/` owns approval policy evaluation, rule storage,
  and reviewer orchestration.
- `packages/coding-agent/src/utils/git-worktree.ts` provides worktree resolution and creation that
  child-agent isolation can reuse.
- `packages/tui/test/keys.test.ts` already proves terminal parsing for `alt+1`.

Still missing first-party pieces:

- Read-only interactive TUI agent viewer that never advances child lifecycle on focus or tab switch.

## Architecture decision

Native multi-agent is a durable control-DB lifecycle service, not a terminal-pane, subprocess, or
in-memory store authority.

`LifecycleCoordinator` owns control-plane commands; repository/SQLite transactions own durable graph,
runtime ownership, agent-row, and outbox truth. `MultiAgentStore`, TUI, terminal panes, extension widgets,
and workflow commands are projections or clients. Mutating commands carry exact owner process identity and fail on
foreign ownership; repository transactions manage revision internally. Viewing an agent is
read-only: switching tabs, opening a transcript, or pressing `Alt+1` through `Alt+9` must not wake,
resume, close, interrupt, or otherwise advance a child.

Steering is a mailbox command, not an edit to a live input buffer. Core records pending, accepted,
rejected, and delivered states. Children consume steering only at safe checkpoints: before the next
model call, after a tool result, or while waiting for input.

Accounts own resource policy only: model/account choice, provider fallback, token budgets,
concurrency caps, and rate limits. Agent-type profiles are a lightweight local policy for selecting
child session model/thinking defaults before account-level resource controls grow richer. Accounts do
not own mailbox state, workflow state, or UI selection state. `MultiAgentStore` copies account metadata through a whitelist so snapshots cannot
smuggle mailbox messages, workflow state, or selected-agent UI state into account records.

Workflow extensions compile into core operations: spawn, message, wait, and cancel.
They do not own lifecycle state.

## Core store design

`MultiAgentStore` is the in-process projection boundary. It owns copied projections, UI selection,
mailbox/direct-file-reference validation, listeners, and metadata helpers. It does not expose lifecycle
or steering mutation methods. Child-session dispatch, detached jobs, cancellation, steering, recovery,
and terminalization enter through `LifecycleCoordinator`; detached runners directly submit their in-memory
identity, outcome, and output metadata. Runtime handles remain outside durable store state.

### State

```ts
type AgentLifecycleState =
	| "running"
	| "waiting_for_input"
	| "steering_pending"
	| "cancelling"
	| "completed"
	| "failed"
	| "aborted";

interface AgentNode {
	id: string;
	parentId: string | undefined;
	displayName: string;
	agentType: string;
	lifecycle: AgentLifecycleState;
	revision: number;
	createdAt: string;
	updatedAt: string;
	cwd: string;
	worktree?: { path: string; branch?: string; base?: string };
	model?: { providerId: string; modelId: string; thinkingLevel?: string };
	account?: { id: string; budgetId?: string };
	permission: { policy: string; inheritedFrom?: string; narrowed: boolean };
	slot?: { index: number; pinned: boolean };
	transcript?: { sessionId: string; path?: string };
	eventStream?: { path: string; eventCount: number; truncated: boolean; byteLimit?: number };
	worker?: { adapter: "runtime" | "terminal" | "subprocess"; handleId: string; cwd?: string };
	lastActivity?: AgentActivity;
	result?: AgentResult;
	error?: { message: string; code?: string };
}
```

Runtime-only handles live outside `AgentNode` in an internal `AgentRuntimeHandle` map keyed by
agent ID. Handles can contain abort controllers, child `AgentSession` instances, timers, process
handles, terminal pane clients, or cleanup callbacks. They are never persisted and never sent to the
TUI. Persisted worker adapter metadata is only a core-owned pointer; terminal and subprocess workers
still mutate lifecycle through exact-owner coordinator commands and coordinate through the same mailbox
and permission contracts as model-backed child agents.

Transcript and event stream fields are durable metadata only. They point to child session/event-log
files and carry bounded counters such as `eventCount`, `truncated`, and optional `byteLimit`;
inline child output is excluded from core snapshots and UI projections.

### Revisions

Every lifecycle mutation increments the target agent revision inside the repository transaction.
Coordinator and model-facing commands never accept an expected revision. `cancel_agent` commits from
current durable state before invoking abort, and `send_agent_message` derives its sender from the current
session. Read commands do not require revision. Pinned-slot metadata may still return a current projection
for UI conflict resolution; it is not lifecycle authority.

`getProjectionSnapshot()` includes raw copied agents plus TUI-facing row projections. Rows derive
display name, lifecycle, revision, active state, selection state, pinned slot index, and terminal or
subprocess adapter type from current core state. Stale slot mutations return the latest projection
with the conflict so visible rows and pane slots can redraw by agent ID before retrying.
`app.agent.slot1` through `app.agent.slot9` default to `Alt+1` through `Alt+9`; consuming those
bindings should call `selectAgentSlot(index)`, which only updates selected view state and never
advances lifecycle or revisions.
Pinned slots are unique. If a caller tries to pin an agent into an occupied slot, core returns a
`slot_conflict` with the occupant and current projection instead of changing either binding.

### Lifecycle transitions

Allowed lifecycle transitions:

| From | To |
|---|---|
| `running` | `waiting_for_input`, `steering_pending`, `cancelling`, `completed`, `failed`, `aborted` |
| `waiting_for_input` | `running`, `steering_pending`, `cancelling`, `completed`, `aborted` |
| `steering_pending` | `running`, `waiting_for_input`, `cancelling`, `failed`, `aborted` |
| `cancelling` | `aborted`, `failed`, `completed` |
| terminal states | no transitions except read-only annotation updates |

Terminal states are `completed`, `failed`, and `aborted`.

Active counts are derived from non-terminal states only. They are not cached by the TUI.

### Command boundaries

| Boundary | Mutation | Notes |
|---|---|---|
| child construction + `LifecycleCoordinator.commitRunningChild` | child row, parent link, `running` revision 1, process owner | Construction precedes persistence. |
| construction interruption/failure | `failed` revision 1 | Persists the construction error; no startup row is left behind. |
| `requestSteering` / `acknowledgeSteeringDelivery` | steering message and lifecycle | Atomic mailbox transport reference plus exact-owner state update. |
| `requestCancellation` / exit acknowledgement | `cancelling` / terminal | Abort follows committed cancellation; terminal state requires exact-owner acknowledgement. |
| `finalizeChild` | terminal agent row, outbox notification | One transaction; duplicate exact result is idempotent. |
| detached runner `finalize` | own terminal agent row, outbox notification | In-memory identity, outcome, and output metadata only. |
| `selectAgentView`, slot and metadata helpers | projection/metadata only | Cannot mutate lifecycle or revision. |
| `listAgents`, `getAgent` | none | Snapshot projections. |

### Mailbox

Mailbox messages are durable coordination events:

```ts
interface AgentMailboxMessage {
	id: string;
	threadId?: string;
	fromAgentId: string;
	toAgentId: string;
	kind: "message" | "ask" | "reply" | "steer" | "parent_request" | "system";
	status: "pending" | "accepted" | "rejected" | "delivered" | "failed";
	createdAt: string;
	updatedAt: string;
	body?: string;
	fileRefs?: Array<{ path: string; label?: string }>;
	targetCheckpoint?: "next_model_call" | "after_tool_result" | "when_waiting";
	error?: string;
}
```

`steer` is a mailbox kind with stricter routing. It is consumed by the child runtime at safe
checkpoints. Spawned child dispatches perform a final runtime-coordination drain before end-of-turn
completion, so steering that races with turn end is delivered before terminalization and cannot remain
pending after the child reaches `completed`. Delivery acknowledgement changes message status; it does
not mutate message body.

Structured protocol messages such as cancellation, max-turn wrap-up, and permission clarifications
must remain tagged as protocol/system messages until explicitly rendered for the model.

### Direct file references

Mailbox messages and agent results carry direct file references. Every `path` is absolute and is
validated when entering the store, runtime mailbox, or persisted mailbox payload.

```ts
interface AgentFileReference {
	path: string;
	label?: string;
}
```

Background Bash/Pyrun jobs expose their live and terminal log file through `result.fileRefs`, so the
TUI can read the same file without registry lookup.

### TUI projection

The TUI subscribes to snapshots and events. It may store view-local selection, scroll position, and
expanded rows, but not lifecycle truth.

Rules:

- `Alt+1` through `Alt+9` select slots only.
- Opening a transcript calls `selectAgentView(id)` and receives a snapshot.
- Viewer stop/steer/resume buttons call explicit core commands without caller revision tokens.
- The repository reads current state transactionally and the viewer refreshes from committed projections.
- Slot order is stable while an agent exists. Pinned slots survive refreshes. Unpinned slots may be
  recomputed from core snapshots, but never from rendered row order alone.

### Persistence

Persisted lifecycle, ownership, agent, and mailbox state lives in control-DB rows keyed by session path.
The parent session JSONL additionally carries `agent_start` and `agent_complete` custom records as the
restart-admission journal for transcript-backed child agents. These records do not replace control-DB
lifecycle truth: recovery requires both an unmatched start and valid persisted agent/transcript identity.
Runtime mailbox transport rows reference stored mailbox messages by
`(store_session_path, store_message_id)` instead of copying bodies; payload bodies and absolute `fileRefs`
resolve from `multi_agent_mailbox_messages`.

Agent and message IDs are allocated transactionally. Legacy counter rows are merged by maximum value
into `multi_agent_counters_v2` during schema initialization, then the legacy counter and artifact tables
are dropped so relocation cannot resurrect stale state or reuse IDs. Mailbox message rows may be updated
only when stored and incoming identities are complete and their sender, recipient, kind, thread, and
message ID identity match; incomplete or conflicting reuse fails without overwriting the existing row.

Runtime handles for transcript-backed children are reconstructed only for unmatched parent JSONL starts.
Restart preserves the same agent and transcript identity, then reacquires exact process ownership before
resuming the child transcript. A matching completion record prevents reconstruction. Missing or mismatched
transcript identity commits explicit failure; recovery never invents success from a missing handle.

## Extension audit

### HazAT/pi-interactive-subagents

Source: <https://github.com/HazAT/pi-interactive-subagents>

Useful:

- Async completion wakeups into the parent.
- Child-to-parent help request via `caller_ping`.
- Resumable child sessions and role agent definitions.
- Terminal pane adapters for users who want visible workers.

Avoid in core:

- Terminal screen or pane state as the liveness source.
- Shell-ready delays and multiplexer-specific timing.
- Focus restoration as part of lifecycle correctness.

Keep as adapter idea only. Native core must work headless and expose enough state for tmux/cmux-like
extensions to render panes without owning truth.

### nicobailon/pi-subagents

Source: <https://github.com/nicobailon/pi-subagents>

Useful:

- Rich role taxonomy: scout, researcher, planner, worker, reviewer, oracle, verifier.
- Natural workflow prompts for second opinions, parallel reviews, review loops, and worker handoff.
- Direct file-reference result storage and background completion delivery.
- Project-agent confirmation and recursion guard.

Avoid in core:

- Large mode/config surface in v1.
- Workflow graph state as lifecycle source of truth.
- Giant event logs carrying full outputs instead of direct file references.

Reuse mainly as workflow and direct-file-reference inspiration.

### tintinweb/pi-subagents

Source: <https://github.com/tintinweb/pi-subagents>

Useful:

- Claude-style tools: `Agent`, `get_subagent_result`, `steer_subagent`.
- Live `/agents` viewer, foreground/background execution, group join, resume, and max-turn wrap-up.
- Agent frontmatter for tools, model, thinking level, prompt mode, context inheritance, and default
  background behavior.

Avoid in core:

- Treating extension exclusion as a security boundary.
- Cron/scheduling and auto-commit worktree behavior in the first core slice.

Reuse API naming and viewer behavior, but put security and lifecycle state in Pi core.

### gotgenes/pi-subagents

Source: <https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents>

Useful:

- Closest shape to native Pi: in-process service, typed lifecycle bus, observer stack, and FIFO
  concurrency limiter.
- `subagent`, `get_subagent_result`, `steer_subagent`, `/agents`, and settings surfaces.
- Agent frontmatter where explicit agent files lock model/thinking/max-turn/context/background
  defaults and tool calls only fill unspecified fields.

Avoid in core:

- Depending on companion packages for baseline permission/worktree safety.

This is the strongest implementation reference for Pi's first-party service boundary.

### pi-sub-agent

Source: <https://pi.dev/packages/pi-sub-agent>

Useful:

- Minimal subprocess adapter model.
- Prompt delivery through stdin instead of command-line arguments.
- Recursive delegation block, project-agent trust confirmation, output truncation, and full-output
  output file with restricted permissions.

Avoid in core:

- Synchronous-only result model.
- No mailbox, steering acknowledgement, or resume semantics.

Keep subprocess execution as an explicit isolation adapter, never a lifecycle-authority fallback.

### pi-intercom

Source: <https://github.com/nicobailon/pi-intercom>

Useful:

- Direct session messaging, ask/reply threading, pending asks, and child-only
  `contact_parent`.
- Local broker model for routing by session ID/name.
- Inline rendering plus persisted session-history extension entries.

Avoid in core:

- Global broker trust without first-party sender identity and permission policy.

Reuse mailbox semantics, not necessarily the broker implementation.

## Claude Code audit

Local source: `/home/osso/Repos/claude-code`.

Useful patterns:

- `src/tasks/LocalAgentTask/LocalAgentTask.tsx` separates running runtime refs from persisted
  transcript/result state and keeps pending steering messages for running agents.
- `src/tasks/InProcessTeammateTask/` models teammate identity, pending user messages, idle state,
  shutdown requests, and permission mode separately.
- `src/tools/shared/spawnMultiAgent.ts` accepts name, prompt, team, cwd, split-pane preference,
  plan-mode flag, model, agent type, and description.
- `src/utils/mailbox.ts` is a small FIFO mailbox with waiters and revisions.
- `src/utils/teammateMailbox.ts` uses per-agent file inboxes with locking and read marks.
- `src/utils/swarm/inProcessRunner.ts` gives message priority order: pending user messages,
  shutdown requests, team-lead messages, peer messages, then task-list claims.
- `TaskOutputTool` has a useful blocking/non-blocking retrieval shape, but the codebase now
  prefers reading output files directly.

Pitfalls:

- Claude has multiple task models with different status enums. Pi should keep execution-agent
  state separate from todo/workflow tasks.
- UI queued-message context is display metadata, not mailbox delivery.
- Runtime refs such as `AbortController`, callbacks, cleanup functions, and sets must not be
  treated as serializable state.
- Structured protocol messages must bypass normal LLM context unless explicitly rendered as user
  messages.
- A capped UI message mirror is not a transcript.

## Implemented boundary

- Control-DB repository transactions enforce lifecycle transition legality and exact process ownership.
- Orchestration-capable runtimes require issued execution capability before agent tools/listeners load.
- Spawn, cancellation, attached recovery, steering, detached Bash/Pyrun finalization, agent-row terminal
  truth, outbox delivery, and agent-row waits use the durable lifecycle protocol. Cancellation timeout
  alone leaves an abort-ignoring child `cancelling`; exact-owner exit acknowledgement or dead-owner
  recovery settles the existing cancellation intent as `aborted/lost_runtime`.
- `MultiAgentStore` remains a projection and metadata surface; direct lifecycle methods are deleted.
- TUI/view selection and pinned slots remain read-only with respect to lifecycle.
