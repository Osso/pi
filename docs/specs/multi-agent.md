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
- [x] Commands that mutate agent state carry an expected revision and fail with a conflict when
      the caller is acting on stale state.
- [x] Viewing, focusing, or switching to an agent is read-only and must not resume, wake, close,
      cancel, or otherwise advance that agent.
- [x] Active-agent counts derive only from core lifecycle state, not from visible panes, rendered
      rows, cached UI state, or subprocess lists.
- [ ] Parent sessions can spawn child agents, wait for status/result updates, cancel children, and
      list descendants without depending on the TUI.
- [x] `spawn_agent` can use a production child `AgentSession` factory that creates a child session
      with the parent's model, model registry, cwd, and `parentSession` metadata.
- [ ] Agent transcripts and event streams are durable enough for restart/resume and are bounded so
      large child output does not become an unbounded event log.

### Mailbox and steering

- [x] Steering is delivered through the mailbox as a command, not by editing a live prompt/input
      buffer.
- [x] A steering message can target a whole agent or a safe checkpoint such as the next model call,
      after a tool result, or while the child is waiting for input.
- [x] Core exposes steering acknowledgement so the TUI can show pending, accepted, rejected, or
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
  architecture, core store shape, mailbox design, and read-only TUI projection rules.
- [`docs/specs/approval-system.md`](approval-system.md) defines the approval policy contract that
  child agents must inherit or narrow.
- [`docs/specs/worktree-startup-option.md`](worktree-startup-option.md) defines worktree startup
  behavior that child-agent isolation can reuse.

## Implementation inventory

- [`packages/coding-agent/src/core/multi-agent-store.ts`](../../packages/coding-agent/src/core/multi-agent-store.ts)
  defines the first pure in-memory store, lifecycle transitions, revision checks, active-count
  derivation, steering mailbox acknowledgement behavior, and SessionManager-backed snapshot
  persistence/reload.
- [`packages/coding-agent/src/core/index.ts`](../../packages/coding-agent/src/core/index.ts) exports
  the first multi-agent store API surface.
- [`packages/coding-agent/src/extensions/multi-agent.ts`](../../packages/coding-agent/src/extensions/multi-agent.ts)
  registers the first store-backed `spawn_agent`, `list_agents`, `wait_agent`, `cancel_agent`, and
  `steer_agent` tool surface without spawning real child model sessions.
- [`docs/wiki/systems/multi-agent.md`](../wiki/systems/multi-agent.md) records the current
  external-extension and Claude Code audit that informs the first implementation slice.

## Tests asserting this spec

- [`packages/coding-agent/test/multi-agent-store.test.ts`](../../packages/coding-agent/test/multi-agent-store.test.ts)
  asserts stale revision rejection, read-only view selection, steering acknowledgement, and
  core-derived active counts. It also asserts snapshot persistence through SessionManager custom
  entries and rehydration after reopening a persisted session.
- [`packages/coding-agent/test/multi-agent-extension.test.ts`](../../packages/coding-agent/test/multi-agent-extension.test.ts)
  asserts the first extension-facing spawn/list/wait/cancel/steer tool surface is store-backed and
  does not start child model sessions by default. It also asserts the spawn tool can call an
  injected child dispatcher, a real child `AgentSession` factory, or the production child factory
  wrapper and that `wait_agent` reports terminal store state without TUI coupling.

## Known gaps (current cycle)

- [x] Audit existing Pi subagent extensions and local Claude Code task primitives; record which
      behavior should be reused, adapted, or rejected.
- [x] Design the core authoritative agent state store, lifecycle revisions, mailbox commands, and
      read-only TUI projection contract.
- [x] Add the first failing tests for stale-revision rejection, read-only agent switching, mailbox
      steering acknowledgement, and core-derived active counts.
- [x] Add and implement store persistence tests for `SessionManager` custom entries and reloadable
      snapshots/events.
- [x] Add failing extension-tool tests for spawn/list/wait/cancel/steer over `MultiAgentStore`
      without spawning real child model sessions.
- [x] Implement extension-facing spawn/list/wait/cancel/steer tools over `MultiAgentStore`, update
      `docs/specs/multi-agent.md`, run targeted tests and `npm run check`.
- [x] Add and implement injected child-dispatcher tests behind `spawn_agent` plus terminal-state
      `wait_agent` behavior without TUI coupling.
- [x] Add and implement real child `AgentSession` factory tests behind `spawn_agent` and
      terminal-state `wait_agent` behavior without TUI coupling.
- [x] Implement production child `AgentSession` factory wiring for `spawn_agent` using existing
      session primitives, without real provider calls in tests.

## Out of scope

- Running child agents with broader permissions than the parent.
- Making cmux a required dependency.
- Treating workflow templates as the source of truth for lifecycle state.
