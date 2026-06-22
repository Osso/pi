# Multi-agent System

This page records the current design direction for Pi's native multi-agent system. The spec
contract lives in [`docs/specs/multi-agent.md`](../../specs/multi-agent.md).

## Current state

Pi does not have a first-party multi-agent runtime yet. Current primitives worth reusing:

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

Missing first-party pieces:

- Authoritative child-agent store with stable IDs, parent IDs, lifecycle state, monotonic
  revisions, cwd/worktree/model/account metadata, permission metadata, and pinned display slots.
- Headless spawn/list/wait/cancel APIs.
- Durable mailbox and steering acknowledgements.
- Read-only TUI agent viewer that never advances child lifecycle on focus or tab switch.
- Bounded artifact store so diffs/logs/results do not become unbounded mailbox events.

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
concurrency caps, and rate limits. Accounts do not own mailbox state, workflow state, or UI
selection state.

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
	lastActivity?: AgentActivity;
	result?: AgentResult;
	error?: { message: string; code?: string };
}
```

Runtime-only handles live outside `AgentNode` in an internal `AgentRuntimeHandle` map keyed by
agent ID. Handles can contain abort controllers, child `AgentSession` instances, timers, process
handles, or cleanup callbacks. They are never persisted and never sent to the TUI.

### Revisions

Every state mutation increments the target agent revision. Commands that mutate a specific agent
must include `expectedRevision`. If it does not match, the store returns:

```ts
{
	ok: false,
	error: "stale_revision",
	current: AgentSnapshot
}
```

Read commands do not require a revision. TUI clients should refresh from the returned snapshot
instead of retrying blindly.

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
| `cancelAgent(id, expectedRevision, reason?)` | moves to `cancelling` or terminal | Runtime handle performs actual abort later. |
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

After the in-memory store tests pass, persist two data classes:

- Snapshots/events as `SessionManager.appendCustomEntry()` with `customType:
  "multi_agent_event"`.
- Agent-visible coordination as `appendCustomMessageEntry()` only when a message should enter LLM
  context.

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
