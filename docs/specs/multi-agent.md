# Multi-agent

Pi's multi-agent system lets one interactive session supervise child agents with isolated
context, explicit lifecycle state, mailbox-based coordination, and optional TUI views. The
runtime contract belongs here; implementation details will live in
[`docs/wiki/systems/multi-agent.md`](../wiki/systems/multi-agent.md) once the first slice lands.

## What it must do

### Core runtime

- [ ] Core state is authoritative for every agent; TUI rows, terminal panes, and extension views
      are projections that must resync from core snapshots.
- [ ] Every agent has a stable ID, parent ID, optional pinned display slot, worktree/cwd metadata,
      model/account metadata, permission policy, and monotonic revision.
- [ ] Agent lifecycle transitions are explicit: `queued`, `starting`, `running`,
      `waiting_for_input`, `steering_pending`, `cancelling`, `completed`, `failed`, and
      `aborted`.
- [ ] Commands that mutate agent state carry an expected revision and fail with a conflict when
      the caller is acting on stale state.
- [ ] Viewing, focusing, or switching to an agent is read-only and must not resume, wake, close,
      cancel, or otherwise advance that agent.
- [ ] Active-agent counts derive only from core lifecycle state, not from visible panes, rendered
      rows, cached UI state, or subprocess lists.
- [ ] Parent sessions can spawn child agents, wait for status/result updates, cancel children, and
      list descendants without depending on the TUI.
- [ ] Agent transcripts and event streams are durable enough for restart/resume and are bounded so
      large child output does not become an unbounded event log.

### Mailbox and steering

- [ ] Steering is delivered through the mailbox as a command, not by editing a live prompt/input
      buffer.
- [ ] A steering message can target a whole agent or a safe checkpoint such as the next model call,
      after a tool result, or while the child is waiting for input.
- [ ] Core exposes steering acknowledgement so the TUI can show pending, accepted, rejected, or
      delivered state.
- [ ] Child agents can contact the supervisor without direct access to sibling internals.
- [ ] Mailbox messages can reference artifacts by ID/path so large diffs, logs, summaries, and
      findings are not copied into every coordination event.

### Extension boundaries

- [ ] `agent viewer` is a read-only extension surface for tree/status/transcript inspection plus
      explicit commands such as stop, resume, and steer.
- [ ] `agents mailbox` is a coordination extension surface for inbox/outbox, acknowledgements,
      supervisor contact, and inter-agent messages.
- [ ] `agent artifacts` stores shared outputs such as summaries, findings, diffs, and file links
      outside the mailbox event log.
- [ ] Workflow extensions compile higher-level patterns into core spawn/message/wait operations
      rather than owning a separate runtime.

### Accounts, budgets, and permissions

- [ ] Accounts configure per-agent model/account selection, provider fallback, token budgets,
      concurrency caps, and rate limits.
- [ ] Accounts do not store mailbox messages, workflow state, or UI selection state.
- [ ] Child agents inherit or narrow the parent permission policy; they must not silently broaden
      tool or filesystem access.
- [ ] Optional subprocess or terminal-pane workers remain bounded by the same core permission,
      mailbox, and lifecycle contracts.

### TUI behavior

- [ ] `Alt+1` through `Alt+9` switch visible agent slots without mutating agent lifecycle state.
- [ ] Slot bindings are stable while an agent exists, and pinned slots survive list refreshes.
- [ ] Stale slots resync by agent ID from core state instead of trusting cached TUI rows.
- [ ] TUI controls show stale-revision conflicts and require the user or caller to retry against
      the latest snapshot.

### External extension learnings

- [ ] The first implementation pass audits `HazAT/pi-interactive-subagents`,
      `nicobailon/pi-subagents`, `tintinweb/pi-subagents`, `@gotgenes/pi-subagents`,
      `pi-sub-agent`, and `pi-intercom` before finalizing the first core API.
- [ ] Pi may reuse terminal-pane ideas from external extensions, but native core behavior must work
      headless and must not depend on cmux.

## How it works

- [`docs/wiki/systems/multi-agent.md`](../wiki/systems/multi-agent.md) will describe the runtime
  architecture after the first implementation slice.
- [`docs/specs/approval-system.md`](approval-system.md) defines the approval policy contract that
  child agents must inherit or narrow.
- [`docs/specs/worktree-startup-option.md`](worktree-startup-option.md) defines worktree startup
  behavior that child-agent isolation can reuse.

## Implementation inventory

- No first-party runtime implementation yet.
- [`docs/wiki/systems/multi-agent.md`](../wiki/systems/multi-agent.md) records the current
  external-extension and Claude Code audit that informs the first implementation slice.

## Tests asserting this spec

- No first-party runtime tests yet.

## Known gaps (current cycle)

- [x] Audit existing Pi subagent extensions and local Claude Code task primitives; record which
      behavior should be reused, adapted, or rejected.
- [ ] Design the core authoritative agent state store, lifecycle revisions, mailbox commands, and
      read-only TUI projection contract.
- [ ] Add the first failing tests for stale-revision rejection, read-only agent switching, mailbox
      steering acknowledgement, and core-derived active counts.

## Out of scope

- Running child agents with broader permissions than the parent.
- Making cmux a required dependency.
- Treating workflow templates as the source of truth for lifecycle state.
