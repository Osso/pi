# Multi-agent System

This page records the current design direction for Pi's native multi-agent system. The spec
contract lives in [`docs/specs/multi-agent.md`](../../specs/multi-agent.md).

## Current state

Pi now has the first pure multi-agent store in
`packages/coding-agent/src/core/multi-agent-store.ts`. It proves the core synchronization rules and
SessionManager-backed snapshot reload before any child model sessions, subprocesses, or TUI views
are added.

`packages/coding-agent/src/extensions/multi-agent.ts` adds the first store-backed tool surface:
`agent_artifacts`, `agent_viewer`, `spawn_agent`, `list_agents`, `wait_agent`, `cancel_agent`,
`contact_supervisor`, `send_agent_message`, and `steer_agent`. These tools mutate or read
`MultiAgentStore`. The read-only `agents_mailbox` tool is temporarily disabled.
`spawn_agent` can call an injected child dispatcher or create a child `AgentSession` through an
injected factory. `wait_agent` synchronizes with those live dispatches without reporting final state.
`createProductionChildAgentSessionFactory()` now wraps the normal `createAgentSession()` and
`SessionManager.create()` primitives so production callers can create child sessions with the
parent cwd, model, model registry, and `parentSession` metadata. The default path intentionally
does not create live child model sessions yet. `list_agents` returns active agents by default and
can include inactive agents or scope results to descendants below a parent ID, using core store state
rather than rendered TUI rows. `contact_supervisor` lets a child
send a pending mailbox request only to its direct parent or root supervisor; it does not accept an
arbitrary sibling target. Mailbox messages can carry sanitized artifact references with IDs, paths,
and labels, so large logs or diffs stay outside coordination events. `wait_agent` only synchronizes
until the target finishes; it returns no agent output, and mailbox messages stay on the mailbox path.
The store also supports revision-checked pinned slot updates while preserving stable metadata and
lifecycle state. `getProjectionSnapshot()` returns copied agent/mailbox/slot projections so UI
surfaces can resync from core state by agent ID instead of trusting stale rendered rows.
`send_agent_message` creates direct mailbox messages only across parent-child relationships, so
siblings cannot target each other directly.
`agent_artifacts` records and lists shared artifact pointers outside mailbox events.
`agent_viewer` is read-only, requires an agent ID, and returns one agent's snapshot, status,
transcript pointer, child IDs, and stop/steer command descriptors; those descriptors name existing
tools and do not mutate agent lifecycle by themselves.
`createMultiAgentWorkflowOperations()` exposes store-backed spawn/message/wait/artifact operations
for higher-level workflow extensions without giving them a separate runtime state store.
`spawnChildAgent()` inherits parent model/account budget metadata and rejects permission broadening.
Production child sessions also resolve agent-type profiles from settings. The built-in profiles are
`explore` (`openai/gpt-5-mini`, low thinking), `verifier` (`openai/gpt-5-mini`, low thinking),
`implement` (`openai/gpt-5.5`, medium thinking), and `reviewer` (`openai/gpt-5.5`, medium
thinking). User settings can override them with `agents.<type>.model` and
`agents.<type>.thinkingLevel`.

## Runtime ownership and recovery

The supervisor is the only orchestration authority. Child runtimes reject direct
`spawn_agent`, `attach_session_agent`, and `wait_agent` calls, the equivalent Hostrun/Pyrun
bridge methods, and `/bg`; production child sessions exclude those tools as a second boundary.

At supervisor start, queued rows remain queued. After a current runtime mailbox listener registers,
`abortInactiveSessionSpawnedAgents()` transactionally scans persisted stores with matching
`session_metadata`. It selects explicitly ended stores (`session_health.pid = NULL`) and duplicate
metadata paths differing from the exact live path freshly asserted on that session's main listener.
The assertion is trusted only while its assertion timestamp matches the listener heartbeat; pathless
or legacy timestamp-only heartbeats invalidate it. Session-path relocation moves the assertion in the
same transaction as the store. Any active spawned row (explicit `origin: "spawned"` or absent origin)
becomes
`aborted` with a `supervisor_restarted` interruption error; the update increments revision, clears
worker metadata, and preserves unrelated JSON. Attached, queued, terminal, missing-health, current
live, and stale-but-process-backed timeout rows stay unchanged. `list_sessions` invokes the same
reconciliation immediately after listener/health
synchronization, so historical non-current stores cannot retain active ghosts. Attached-session rows
retain the transcript-backed resume path; attached rows already waiting for input remain idle.

`wait_agent` accepts only an in-process dispatch or a current-process detached Bash/Pyrun job
with transient `runtime` worker metadata. The store removes active worker metadata on restore, so
persisted process metadata cannot keep a wait polling forever.

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

- Startup/runtime registration that opts `spawn_agent` into the production child factory.
- Blocking wait/notification behavior beyond immediate store snapshots.
- Incremental event replay beyond latest snapshot reload.
- Read-only TUI agent viewer that never advances child lifecycle on focus or tab switch.
- Bounded artifact store for storing referenced diff/log/result payloads outside mailbox events.

## Architecture decision

Native multi-agent should be an in-process core service, not a terminal-pane or subprocess
orchestrator.

Core owns truth. TUI, terminal panes, extension widgets, and workflow commands are projections or
clients. Mutating commands carry an expected revision and fail on stale state. Viewing an agent is
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

Workflow extensions compile into core operations: spawn, message, wait, cancel, and artifact reads.
They do not own lifecycle state.

## Core store design

`MultiAgentStore` is the first implementation boundary. It should be pure TypeScript state plus a
small event emitter; no model calls, subprocess spawning, terminal panes, filesystem writes, or TUI
objects in the first slice.

### State

```ts
type AgentLifecycleState =
	| "queued"
	| "starting"
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
still mutate lifecycle through revision-checked commands and coordinate through the same mailbox and
permission contracts as model-backed child agents.

Transcript and event stream fields are durable metadata only. They point to child session/event-log
artifacts and carry bounded counters such as `eventCount`, `truncated`, and optional `byteLimit`;
inline child output is excluded from core snapshots and UI projections.

### Revisions

Every state mutation increments the target agent revision. Commands that mutate a specific agent
and accept caller-supplied concurrency guards must include `expectedRevision`. Model-facing tools may
derive the current revision internally when exposing it would make the tool awkward; `cancel_agent`
derives the current revision before aborting. `send_agent_message` derives its sender from the
current session instead of accepting caller-supplied sender/revision fields. If an
`expectedRevision` guard does not match, the store returns:

```ts
{
	ok: false,
	error: "stale_revision",
	current: AgentSnapshot,
	projection?: MultiAgentProjectionSnapshot
}
```

Read commands do not require a revision. TUI clients should refresh from the returned snapshot
instead of retrying blindly.

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
| `queued` | `starting`, `aborted` |
| `starting` | `running`, `failed`, `aborted` |
| `running` | `waiting_for_input`, `steering_pending`, `cancelling`, `completed`, `failed`, `aborted` |
| `waiting_for_input` | `running`, `steering_pending`, `cancelling`, `completed`, `aborted` |
| `steering_pending` | `running`, `waiting_for_input`, `cancelling`, `failed`, `aborted` |
| `cancelling` | `aborted`, `failed`, `completed` |
| terminal states | no transitions except read-only annotation updates |

Terminal states are `completed`, `failed`, and `aborted`.

Active counts are derived from non-terminal states only. They are not cached by the TUI.

### Core commands

The first store-level commands:

| Command | Mutation | Notes |
|---|---|---|
| `spawnAgent(input)` | creates `AgentNode` at `queued` or `starting` | Does not call a model in first slice. |
| `transitionAgent(id, expectedRevision, lifecycle, details?)` | lifecycle update | Enforces transition table. |
| `selectAgentView(id)` | none | Returns a snapshot and records UI-only selection outside lifecycle state. |
| `pinAgentSlot(id, expectedRevision, slot)` | slot update | Stable `Alt+number` mapping. |
| `clearAgentSlot(id, expectedRevision)` | slot update | Does not affect lifecycle. |
| `sendMailboxMessage(input)` | creates message | Used for supervisor contact and peer messages. |
| `sendSteering(id, expectedRevision, message, target?)` | creates steering message and marks pending | Does not edit prompt buffer. |
| `ackSteering(id, messageId, expectedRevision, status)` | updates steering status | Status: accepted, rejected, delivered, failed. |
| `cancelAgent(id, reason?)` | derives the current revision, then moves to `cancelling` or terminal | Runtime handle performs actual abort later. |
| `recordArtifact(input)` | creates artifact pointer | Stores metadata/pointer, not full large output. |
| `listAgents(filter?)` | none | Snapshot projection. |
| `getAgent(id)` | none | Snapshot projection. |

### Mailbox

Mailbox messages are durable coordination events:

```ts
interface AgentMailboxMessage {
	id: string;
	threadId?: string;
	fromAgentId: string;
	toAgentId: string;
	kind: "message" | "ask" | "reply" | "steer" | "supervisor_request" | "system";
	status: "pending" | "accepted" | "rejected" | "delivered" | "failed";
	createdAt: string;
	updatedAt: string;
	body?: string;
	artifactIds?: string[];
	targetCheckpoint?: "next_model_call" | "after_tool_result" | "when_waiting";
	error?: string;
}
```

`steer` is a mailbox kind with stricter routing. It is consumed by the child runtime at safe
checkpoints. Delivery acknowledgement changes message status; it does not mutate message body.

Structured protocol messages such as cancellation, max-turn wrap-up, and permission clarifications
must remain tagged as protocol/system messages until explicitly rendered for the model.

### Artifact pointers

Large outputs live as artifacts:

```ts
interface AgentArtifact {
	id: string;
	agentId: string;
	kind: "summary" | "diff" | "log" | "finding" | "transcript" | "file";
	title: string;
	path?: string;
	inlinePreview?: string;
	metadata?: Record<string, unknown>;
	createdAt: string;
}
```

Mailbox messages and agent results reference artifact IDs. This prevents background runs from
duplicating large logs in every event.

### TUI projection

The TUI subscribes to snapshots and events. It may store view-local selection, scroll position, and
expanded rows, but not lifecycle truth.

Rules:

- `Alt+1` through `Alt+9` select slots only.
- Opening a transcript calls `selectAgentView(id)` and receives a snapshot.
- Viewer stop/steer/resume buttons call explicit core commands with `expectedRevision`.
- A stale-revision response replaces the local row from `current` and shows a conflict message.
- Slot order is stable while an agent exists. Pinned slots survive refreshes. Unpinned slots may be
  recomputed from core snapshots, but never from rendered row order alone.

### Persistence

The first persistence slice writes full store snapshots:

- Snapshots use `SessionManager.appendCustomEntry()` with `customType: "multi_agent_event"`.
- `MultiAgentStore.fromSessionManager()` rehydrates the latest valid snapshot from reopened session
  entries.
- Agent-visible coordination should use `appendCustomMessageEntry()` later only when a message
  should enter LLM context.

Runtime handles are reconstructed from durable state only when an operation requires it. Restarted
sessions may show previous agents as terminal, detached, or resumable; they must not pretend a dead
runtime is still running.

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
- Artifact/result storage, doctor command, bounded fanout/depth, and background completion delivery.
- Project-agent confirmation and recursion guard.

Avoid in core:

- Large mode/config surface in v1.
- Workflow graph state as lifecycle source of truth.
- Giant event logs carrying full outputs instead of artifact pointers.

Reuse mainly as workflow and artifact inspiration.

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

- Minimal subprocess fallback model.
- Prompt delivery through stdin instead of command-line arguments.
- Recursive delegation block, project-agent trust confirmation, output truncation, and full-output
  artifact file with restricted permissions.

Avoid in core:

- Synchronous-only result model.
- No mailbox, steering acknowledgement, or resume semantics.

Keep subprocess execution as fallback/isolation mode, not the primary architecture.

### pi-intercom

Source: <https://github.com/nicobailon/pi-intercom>

Useful:

- Direct session messaging, ask/reply threading, pending asks, and child-only
  `contact_supervisor`.
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

## First native slice

1. Add core types for `AgentNode`, lifecycle state, revision, command result, mailbox message,
   steering status, and artifact pointer.
2. Add an in-memory `MultiAgentStore` with pure state transitions and tests for stale revision
   rejection, active-count derivation, read-only view selection, and steering acknowledgements.
3. Persist snapshots/events as session custom entries only after the state machine is tested.
4. Add extension-facing tools on top of the store: spawn/list/wait/cancel/steer.
5. Add TUI viewer as a projection, then bind `Alt+1` through `Alt+9` to visible slots.

The first code slice should not spawn real child model sessions. It should prove the core state
machine and UI/core synchronization rules first.
