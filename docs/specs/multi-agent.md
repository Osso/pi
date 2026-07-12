# Multi-agent

Module boundary: split first-party extension modules (`agents-core`, `agent-viewer`, `agents-mailbox`) over the core `MultiAgentStore`.

Pi's multi-agent system lets one interactive session supervise child agents with isolated
context, explicit lifecycle state, mailbox-based coordination, and optional TUI views. The
runtime state belongs in core, while user/model-facing affordances should be delivered as
first-party extension modules: an agents-core tool surface, an agent-viewer projection, and
an agents-mailbox coordination surface. The runtime contract belongs here; implementation details will live in
[`docs/wiki/systems/multi-agent.md`](../wiki/systems/multi-agent.md) once the first slice lands.

## What it must do

### Core runtime

- [x] Core state is authoritative for every agent; TUI rows, terminal panes, and extension views
      are projections that must resync from core snapshots.
- [x] Core runtime state is kept separate from first-party extension modules: the core store owns
      lifecycle, revisions, mailbox records, file references, and transcript metadata, while
      extension packages own commands, tools, and presentation surfaces.
- [x] Every agent has a stable ID, parent ID, optional pinned display slot, worktree/cwd metadata,
      model/account metadata, permission policy, and monotonic revision.
- [x] Agent lifecycle transitions are explicit: `queued`, `starting`, `running`,
      `waiting_for_input`, `steering_pending`, `cancelling`, `completed`, `failed`, and
      `aborted`. The state graph, state meanings, and restore-time rewrite rules live in
      [agent-lifecycle.md](agent-lifecycle.md).
- [x] Commands that mutate agent state carry an expected revision and fail with a conflict when
      the caller is acting on stale state. Model-facing tools may derive the current revision
      internally before calling core store operations when exposing the revision would make the
      tool awkward to use.
- [x] Viewing, focusing, or switching to an agent is read-only and must not resume, wake, close,
      cancel, or otherwise advance that agent.
- [x] Active-agent counts derive only from core lifecycle state, not from visible panes, rendered
      rows, cached UI state, or subprocess lists.
- [x] Only the supervisor runtime can spawn, attach, or wait for agents. Child/subagent runtimes
      reject `spawn_agent`, `attach_session_agent`, `wait_agents`, `/bg`, and the Hostrun/Pyrun
      `agents.spawn`, `agents.attachSession`, and `agents.wait` bridge methods before rows are created.
      Production child sessions also exclude those three tools as defense in depth.
- [x] Child runtimes register only their agent-address mailbox listener and never run supervisor-wide
      persisted-store reconciliation, preventing same-PID child startup from retiring or mutating the
      supervisor's main-session state.
- [x] Parent sessions can spawn child agents, wait for status/result updates, cancel children, and
      list descendants without depending on the TUI. `list_agents` visible content identifies each
      returned agent by ID, name, type, active/terminal status, and lifecycle; `agent_viewer` visible
      content includes the inspected agent's status and terminal result summary or error when present.
- [x] Multi-agent orchestration tools do not trigger generic tool approval prompts; child-agent
      host effects remain subject to normal tool approval inside the child session.
- [x] `spawn_agent` requires an executable child-session factory or dispatcher before persisting any row;
      it has no store-only queued fallback. Dormant promptless session attachment remains the explicit
      non-executable operation.
- [x] `spawn_agent` can use a production child `AgentSession` factory that creates a child session
      with the parent's model, model registry, cwd, and `parentSession` metadata.
- [x] Agent-type profiles can select a child model/thinking level; built-in `explore`, `verifier`,
      `documentation-update`, `implement`, and `reviewer` profiles provide default model/thinking
      choices and configured profiles override them.
- [x] Agent transcripts and event streams are durable enough for restart/resume and are bounded so
      large child output does not become an unbounded event log.
- [x] Supervisor session resume restores the persisted multi-agent store into the production
      first-party store so agent tree, slots, file references, mailbox state, and transcript pointers
      survive a crash or restart. The selected view is ephemeral UI state and is not persisted.
- [x] Multi-agent state persists as per-entity rows in the session control DB (one upsert per
      mutated agent or mailbox message), not as snapshots appended to the session
      JSONL transcript; transcripts carry conversation history only.
- [x] Persisted agent and message IDs are allocated from per-session counters. Allocation reconciles
      alternate counter state and existing IDs across agent, mailbox, and runtime mailbox transport rows
      before advancing, so stale counters cannot cause ID reuse. Legacy `multi_agent_counters_v2` rows
      migrate into authoritative `multi_agent_counters` during schema initialization and the alternate
      table is dropped after migration.
- [x] Control-DB schema initialization performs an atomic, durable, one-time cleanup of legacy
      `artifactIds` and `artifactRefs` fields in persisted agent and mailbox payloads, rewrites the
      cleaned rows, installs SQLite INSERT/UPDATE triggers on both payload tables, and continues
      restoring supported state. Already-migrated opens skip the writer transaction and table scan;
      triggers prevent older binaries from reintroducing legacy keys. Malformed rows still fail
      explicitly with contextual validation.
- [x] Forked/branched sessions start with an empty multi-agent store: state is keyed by session
      path and deliberately does not follow forks, so the original and the fork can never both
      auto-restart the same child transcripts.
- [x] In-memory (non-persisted) sessions do not retain multi-agent state across an in-process
      restart: with no session file there is no persistence key, and restore clears the store.
      This is an accepted limitation of non-persisted sessions.
- [x] Restore never rewrites lifecycle state: the last written lifecycle is the truth, and restore
      only clears stale worker handles (runtime metadata that is never proof of liveness). Detachment
      is derived at session start from active lifecycle plus the absence of a live dispatch — see
      [agent-lifecycle.md](agent-lifecycle.md).
- [x] On supervisor session start, detached in-flight attached agents with transcript paths restart
      through the same attached-session dispatch path used by `attach_session_agent`, preserving their
      agent ID, cwd, permission, model/account metadata, and runtime mailbox/lifecycle plumbing;
      attached agents already waiting for input are not auto-prompted. After current runtime mailbox
      listener registration, `abortInactiveSessionSpawnedAgents()` globally terminalizes active
      spawned agents (explicit `spawned` origin or absent origin) in persisted stores with matching
      supervisor metadata and either explicitly ended (`pid: NULL`) health or a non-current duplicate
      metadata path for the same session ID. Main listener rows freshly assert the exact live session
      path and runtime incarnation. A changed incarnation advances health generation and aborts active
      spawned rows in the exact store even when the PID is reused. Replacement by a different PID is
      rejected while the predecessor is still a verified live Pi runtime. Startup reconciliation
      retires non-Pi listener ownership before trusting any asserted live path. Path relocation moves
      the path assertion transactionally with the store. Pathless or legacy timestamp-only heartbeats
      invalidate assertion trust instead of preserving stale paths.
      It writes
      `aborted` with a `supervisor_restarted` interruption error, including waiting children;
      attached, queued, terminal, missing-health, current live, and stale-but-process-backed timeout
      records remain unchanged. Runtime-process verification recognizes Pi executables and source, Bun,
      or built `packages/coding-agent` entrypoints in relative or absolute form. Session-directory
      listener/health synchronization runs the same
      idempotent reconciliation immediately.
      Dispatch finalizers are guarded
      by store restore generation so stale completions cannot mutate a rebound store, and shutdown
      invalidates in-flight dispatches before aborting handles.
- [x] `wait_agents({})` snapshots agents active at invocation and waits until any one reaches a
      terminal state. Pending lifecycle notifications are retried after startup listener setup and
      immediately before each wait. It first consumes one pending completion notification when
      available, so a completed agent never requires another wait; for a failed detached Pyrun job,
      it also consumes one pending failure notification. When consuming either supported notification,
      the direct tool exposes the agent snapshot and notification message in `details`. Other
      terminal failure waits retain their existing status-only behavior. Restore clears transient
      `runtime` worker metadata; persisted metadata never makes a wait poll indefinitely.

### Runtime construction inventory

- Main CLI interactive, print, JSON, and RPC modes share `createAgentSessionServices()` plus
  `createAgentSessionFromServices()` and are orchestration-capable when multi-agent tools/listeners are enabled.
- Public SDK `createAgentSession()` constructs a main runtime and may be orchestration-capable according to its
  configured extensions/tools; it must obey the same capability requirement when orchestration is enabled.
- Production spawned-child and attached-session factories call the SDK factory with an address-scoped agent
  identity. These are execution runtimes and must never receive orchestration execution capability.
- Resident Architect construction is an observer runtime with inbound coordination disabled and is not an
  orchestration-capable main runtime.
- Help, version, model/package listing, and other metadata actions that return before AgentSession construction
  are outside the execution-capability invariant.

### Phase 1 authority and invariants

- `LifecycleCoordinator` is the sole control-plane and runtime-command authority. Spawn, attach,
  dispatch, lease renewal/release, steering, cancellation, recovery, parent/child graph changes,
  and terminalization are submitted as coordinator commands; callers do not write lifecycle rows
  directly. Detached Bash/Pyrun runners are the only exception: they are execution-plane workers
  authorized to submit one exact, fenced terminal-finalize operation for their own lease and may
  not create agents, dispatch work, cancel other agents, recover stores, or mutate the parent graph.
  Shared detached-job artifacts live under an identity-bound job directory with a direct durable
  output file and immutable terminal envelope. Envelope creation fsyncs output first, records its
  size and SHA-256, records the full lease/revision/fencing identity and exact outcome, checksums the
  envelope, atomically renames it into place, and fsyncs the containing directory.
- The repository and SQLite transaction are a second enforcement boundary, not a trust-through
  path. They re-check transition legality, authorization, and the complete mutation predicate
  before committing any lifecycle or terminal-event change. A coordinator response is successful
  only after the durable mutation commits.
- Runtime roles are typed and exclusive. An orchestration-capable main runtime must receive a
  non-null execution capability and validate it before orchestration tools or the main runtime
  listener become visible; construction fails before either is exposed when capability is absent.
  A child runtime is address-scoped execution only and can never receive that capability or expose
  orchestration commands. Non-AgentSession help/inventory startup remains outside this invariant.
- Every lifecycle mutation carries the fencing tuple
  `(agent_id, expected_revision, lease_id, runtime_incarnation, fencing_epoch)`. Missing, stale,
  foreign, or partially matching fields fail the mutation; terminal retries are accepted only as
  an idempotent replay of the same committed terminal event.
- A queued agent is either unreserved and dispatchable or owns exactly one live dispatch
  reservation. Reservation acquisition, reservation identity, lifecycle state, and revision are
  committed atomically. No transaction may expose a dispatchable queued row with two reservations,
  an expired/foreign reservation, or an unowned reservation that a runner can execute.
- Child creation is one coordinator transaction: child row, single parent link, initial revision,
  and either the committed dispatch reservation or an explicitly unreserved dispatchable state are
  created together. Main-runtime children use the synthetic `main` identity as the durable session
  root; nested children require an existing persisted parent. Runtime construction begins only after a
  full-predicate coordinator transition to `starting`; `running` is confirmed only after construction
  succeeds. Construction failure commits `failed`, error projection, terminal event, and outbox through
  the current reservation before any `running` state is exposed. If the supervisor dies after
  reservation commit, resumed production sessions schedule recovery at lease expiry; the coordinator
  acquires recovery leadership, takes the next dispatch epoch, commits `failed/lost_runtime`, and
  retries after leader contention. Runtime-listener registration never mutates lifecycle rows. Production `spawn_agent` requires a persisted supervisor session and
  fails closed otherwise; it has no direct store creation or lifecycle-ramp path. First-party `/bg`
  child-session jobs use the same coordinator reservation/start/confirmation path and retain their
  reservation identity for cancellation and terminal settlement. Terminal replay
  validates the current full lease predicate before idempotency, so an old owner cannot replay a
  finalizer or create another event/outbox row after a higher fencing epoch is acquired. Parent links
  cannot self-reference or form cycles. Cancellation is cascading:
  cancellation first commits `cancelling` through the current reservation; runtime abort is requested
  only after that commit, and `aborted` requires a separate fenced exit acknowledgement. The caller
  waits at most five seconds for tracked dispatch settlement; a runtime that does not exit remains
  `cancelling` until fenced lease-expiry recovery resolves it as lost rather than inventing an exit.
  Interactive Escape submits the same operation through an injected cancellation boundary and never
  directly mutates lifecycle state or invokes a store abort path. Recovery also never converts an
  attached `cancelling` row to `aborted` without fenced runtime exit acknowledgement; it remains
  nonterminal until attached-session ownership is reacquired or resolved as lost. Queued and
  starting children use the same ordering. Cancelling a parent issues cancellation intents to active
  descendants deepest-first, while each descendant still terminalizes through its own fenced command.
  `cancel_agent`, selected-agent Escape, and reserved-runtime shutdown call this same operation. SQLite
  rejects any parent terminal mutation while a persisted descendant remains nonterminal; the coordinator resolves cancellation, owner loss, or lease expiry
  for descendants before terminalizing the parent.
- Externally visible child effects use a deterministic operation identity derived from the durable
  agent identity and command/tool-call revision when the target adapter supports idempotency keys.
  Before starting an effect, the runtime must prove its current lease; loss or failed renewal stops
  new effects. Spawned children are not reassigned or automatically replayed after owner loss, which
  avoids duplicating effects against providers without idempotency support. Effects already accepted
  by a non-idempotent external provider cannot be revoked by fencing; their outcome is recorded as an
  explicit uncertainty on lost-runtime recovery rather than retried or reported as definitely absent.
- Race outcomes are ordered by the coordinator's serialized commit order, never by wall-clock,
  PID, callback order, or notification delivery. A committed terminal result wins all later
  requests; an accepted cancellation wins over a later natural-completion attempt and moves the
  agent to `cancelling`; only a current fenced exit acknowledgement can then produce `aborted`.
  Duplicate abort acknowledgements replay the same terminal outcome without a new revision or event.
  Every state and terminal mutation also requires the lease expiry to be later than the command
  timestamp; an expired owner is fenced even before another runtime takes over. Owner loss or lease
  expiry fences the old runtime, and late finalizers fail the mutation predicate rather than
  rewriting state. Expired-runtime recovery requires the live recovery-leader lease, the expected
  agent revision, and an expired dispatch lease; one transaction acquires the next dispatch fencing
  epoch and commits `failed/lost_runtime` plus its terminal event/outbox. The expiry/owner-loss path
  is never reported as a confirmed abort.
- Each terminal transition inserts exactly one immutable terminal event/outbox record in the same
  SQLite transaction as the state and revision change. Its identity is unique
  `(agent_id, terminal_revision, event_kind)`, and its payload is complete and immutable: terminal
  outcome, cause/error or result reference, parent/agent identity, and the fencing identity that
  authorized the commit are retained for every consumer. Redelivery and retries reuse that identity
  and payload; they never create a second terminal fact.

### Mailbox and steering

- [x] Steering is delivered through the mailbox as a command, not by editing a live prompt/input
      buffer.
- [x] A steering message can target a whole agent or a safe checkpoint such as the next model call,
      after a tool result, or while the child is waiting for input.
- [x] Core exposes steering acknowledgement so the TUI can show pending, accepted, rejected, or
      delivered state.
- [x] Child agents can contact the supervisor without direct access to sibling internals.
- [x] Spawned child dispatches perform a final runtime-coordination drain before end-of-turn completion;
      steering that races with turn end is delivered before terminalization and cannot remain pending
      after the child reaches `completed`.
- [x] Mailbox messages and completion results carry validated absolute `fileRefs` entries so logs,
      diffs, summaries, and findings are referenced directly without registry indirection.
- [x] Persisted mailbox message IDs are stable within a session store. Reuse is checked
      transactionally and allowed only when both stored and incoming identities are complete and
      sender, recipient, kind, thread, and message ID identity match; incomplete or conflicting
      reuse fails explicitly without overwriting the existing message.
- [x] Cross-session mailbox transport is runtime coordination state and must not be persisted in
      session JSONL transcripts or `MultiAgentStore` session snapshots.
- [x] Cross-session mailbox recipients are addressed by `(session_id, agent_id)` where `agent_id`
      is absent/null for the main thread and present for a subagent in that session.
- [x] Every `AgentSession` owns exactly one runtime listener address: a main runtime uses
      `(session_id, null)` and a subagent runtime uses `(session_id, agent_id)`. Registration,
      heartbeat refresh, and retirement use that exact address; a subagent never creates or
      retires a main-thread binding.
- [x] Separate agent sessions can send completion and coordination messages to another session's
      main thread without requiring the receiver to call `wait_agents`.
- [ ] Same-session subagents may address the main thread or another subagent by agent ID, but the
      default common path is child/separate-session to main-thread delivery.
- [ ] Messages addressed to terminal agents are allowed and must either wake/resume that agent when
      possible or remain pending/failed with an explicit reason; they must not be silently dropped.
- [x] Idle sessions poll the runtime mailbox for pending messages at least every 3 seconds, and
      every agent turn also drains pending recipient messages before going idle.
- [x] Each live main session refreshes its runtime mailbox listener and corresponding health activity
      every 60 seconds; session switch or disposal retires its exact old listener and marks matching
      main-session health ended.
- [x] Registering a main-session listener retires other main-session bindings on the same PID, so a
      process has one current main-session identity even if historical listener rows remain. Listener
      rows persist a per-process runtime incarnation so same-PID process replacement advances session
      health generation and reconciles stale spawned rows without disturbing attached agents.
      `list_sessions` and `broadcast` never create listeners or write caller PID health; ownership is
      maintained only by the runtime listener lifecycle. Fresh
      heartbeats are not accepted as PID ownership proof: inventory and signal delivery verify the PID
      still belongs to Pi, and a different verified live Pi PID blocks concurrent session replacement.
- [x] Pending runtime mailbox messages are claimed atomically before enqueue so concurrent Pi
      processes do not deliver the same message twice.
- [x] Claimed messages are marked delivered only after the recipient successfully enqueues the
      follow-up input; failed enqueue leaves an inspectable pending/failed message state.
- [x] If idle delivery races with an active prompt (the recipient is already processing a prompt and cannot accept a follow-up), claimed transport rows are released back to pending for bounded redelivery instead of being marked failed; this prevents spurious failures and preserves at-least-once delivery semantics.
- [x] Runtime mailbox cleanup removes messages older than 30 days because stale coordination
      messages are no longer actionable.
- [x] Delivered mailbox prompts clearly identify their mailbox origin and sender address before the
      content is fed back to the model.
- [x] Runtime mailbox writes are treated as a local trusted-boundary security surface; any process
      with control-DB write access can inject messages, so the feature must not hide message origin.
- [x] A mailbox message has exactly one delivery transport: the runtime control-DB mailbox.
      There is no in-store drain; transport rows reference the persisted store row (one transport
      row per store message, enforced at enqueue), and the store record transitions to delivered
      only when the recipient's process actually delivers the transport row. Steer messages are
      exempt from delivery marking because the steering acknowledgement flow owns their status.
- [x] Multi-agent messaging requires a store persisted to the session control DB. There is no
      in-memory delivery mode: an unpersisted sender cannot enqueue transport rows, and the
      failure is reported explicitly rather than silently falling back.
- [x] `wait_agents({})` first consumes one pending completion notification; for a failed detached
      Pyrun job, it also consumes one pending failure notification; otherwise it waits until any
      agent active at invocation reaches a terminal state. The direct tool returns the winning
      agent's completion or terminal status and, for either supported notification, returns the
      agent and message in `details` while marking the matching runtime mailbox transport row
      delivered. Non-Pyrun failure waits retain their existing status-only behavior. Hostrun/Pyrun
      `pi.agents.wait()` discards that tool result and returns `null`.
- [x] While a session is streaming, runtime mailbox polling leaves pending messages unclaimed;
      whatever remains is drained as follow-up input at the end of the turn.
- [x] The extension context control-DB path falls back to the session's metadata control-DB path,
      so subagent sessions mirror mailbox messages through the same runtime transport as top-level
      sessions.
- [x] A process that has ever advertised its pid as a runtime mailbox listener keeps a permanent
      no-op SIGUSR2 handler installed: reverting to the OS default disposition would let a stray
      wake signal (stale listener row, signal pending across a session switch) terminate the
      process. Self-notification is skipped entirely when no wake handler is installed.

### Extension boundaries

- [x] Multi-agent first-party capabilities are split into explicit extension modules:
      `agents-core` for spawn/list/wait/cancel/steer tools, `agent-viewer` for read-only
      projections and focus commands, and `agents-mailbox` for inbox/outbox/contact/message actions.
- [x] `agent viewer` is a read-only extension surface for tree/status/transcript inspection plus
      explicit commands such as stop, resume, and steer.
- [x] `agents mailbox` is a coordination extension surface for inbox/outbox, acknowledgements,
      supervisor contact, and inter-agent messages.
- [x] Background logs remain visible through direct absolute `fileRefs` on active and completed agent state.
- [x] Workflow extensions compile higher-level patterns into core spawn/message/wait operations
      rather than owning a separate runtime.
- [x] `agents-core` exposes `/bg <prompt>` and `/jobs` commands that submit new prompts as
      background child-agent jobs without blocking the foreground command handler.
- [x] Cancelling a background child-agent job aborts the backing child session when one is still
      running, not only the store lifecycle row.

### Accounts, budgets, and permissions

- [x] Accounts configure per-agent model/account selection, provider fallback, token budgets,
      concurrency caps, and rate limits.
- [x] Accounts do not store mailbox messages, workflow state, or UI selection state.
- [x] Child agents inherit or narrow the parent permission policy; they must not silently broaden
      tool or filesystem access.
- [x] Optional subprocess or terminal-pane workers remain bounded by the same core permission,
      mailbox, and lifecycle contracts.

### TUI behavior

- [x] `Alt+1` through `Alt+9` switch visible agent slots without mutating agent lifecycle state.
- [x] Slot bindings are stable while an agent exists, and pinned slots survive list refreshes.
- [x] Stale slots resync by agent ID from core state instead of trusting cached TUI rows.
- [x] A selected-child banner identifies the agent ID, display name, and lifecycle without exposing
      internal target/view terminology.
- [x] While a child transcript is selected, the footer shows that child session's model, provider,
      and thinking level; live placeholders clear the model display, and returning to the main
      session restores the main footer model.
- [x] The main-session working loader is hidden while a child transcript is selected, preserves
      unrelated status rows, and is restored after returning to a still-streaming main session.
- [x] Escape cancels the currently viewed active child-agent turn before falling back to main-thread
      cancellation or idle Escape behavior.
- [x] TUI controls show stale-revision conflicts and require the user or caller to retry against
      the latest snapshot.

### External extension learnings

- [x] The first implementation pass audits `HazAT/pi-interactive-subagents`,
      `nicobailon/pi-subagents`, `tintinweb/pi-subagents`, `@gotgenes/pi-subagents`,
      `pi-sub-agent`, and `pi-intercom` before finalizing the first core API.
- [x] Pi may reuse terminal-pane ideas from external extensions, but native core behavior must work
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
  defines the authoritative runtime store, lifecycle transitions, revision checks, active-count
  derivation, mailbox acknowledgement behavior, direct absolute `fileRefs` validation, and
  control-DB-backed row persistence. Each agent/mailbox mutation upserts one row keyed by session
  path, and restore selects the session's rows. Multi-agent state is mutable runtime state and is
  not written to the session JSONL transcript; runtime mailbox transport is separate and carries
  required store references rather than copied payloads.
- [`packages/coding-agent/src/core/index.ts`](../../packages/coding-agent/src/core/index.ts) exports
  the first multi-agent store API surface.
- [`packages/coding-agent/extensions/agents-core/src/runtime.ts`](../../packages/coding-agent/extensions/agents-core/src/runtime.ts)
  provides the shared store-backed registration helpers, background job commands, production
  child-session factory, workflow operations, and compatibility aggregate factory.
- [`packages/coding-agent/src/extensions/multi-agent.ts`](../../packages/coding-agent/src/extensions/multi-agent.ts)
  re-exports the first-party extension runtime for compatibility with older internal imports.
- [`packages/coding-agent/extensions/agents-core/src/index.ts`](../../packages/coding-agent/extensions/agents-core/src/index.ts)
  registers `/bg`, `/jobs`, and spawn/list/wait/cancel/steer tools against the shared
  store.
- [`packages/coding-agent/extensions/agent-viewer/src/index.ts`](../../packages/coding-agent/extensions/agent-viewer/src/index.ts)
  registers the read-only tree/status/transcript projection tool against the shared store.
- [`packages/coding-agent/extensions/agents-mailbox/src/index.ts`](../../packages/coding-agent/extensions/agents-mailbox/src/index.ts)
  registers inbox/outbox summary, supervisor-contact, and direct-message tools against the shared store.
- [`packages/coding-agent/src/core/session-control-db.ts`](../../packages/coding-agent/src/core/session-control-db.ts)
  owns the SQLite control database schema, per-session agent/mailbox rows and counters, runtime
  mailbox transport and listener lifecycle, session health, path relocation, and global spawned-agent
  reconciliation.
- [`docs/wiki/systems/multi-agent.md`](../wiki/systems/multi-agent.md) records the current
  external-extension and Claude Code audit that informs the first implementation slice.

## Tests asserting this spec

- [`packages/coding-agent/test/multi-agent-store.test.ts`](../../packages/coding-agent/test/multi-agent-store.test.ts)
  asserts stale revision rejection, read-only view selection, steering acknowledgement, and
  core-derived active counts. It also asserts row persistence through the session control DB,
  rehydration after reopening a persisted session, descendant listing below a parent, and
  child-to-supervisor mailbox contact without sibling targeting. It verifies absolute file
  references are validated at ingress, covers stable
  agent metadata plus pinned slot updates, and exercises the remaining non-terminal lifecycle
  transitions. It also asserts authoritative projection snapshots and slot resync by agent ID from
  current core state. It covers child-agent model/account/budget metadata inheritance, rejects
  permission broadening, keeps account metadata separate from mailbox, workflow, and UI selection
  state, verifies terminal/subprocess worker adapter metadata stays under the same permission,
  mailbox, and lifecycle contracts, persists bounded transcript/event stream metadata across
  SessionManager rehydrate without retaining inline child output logs, and exposes TUI row/slot
  projections plus stale slot-conflict refresh payloads from current core snapshots. It verifies
  visible slot selection is read-only over lifecycle state and conflicting pinned slot claims are
  rejected with the current projection so existing slot bindings stay stable.
- [`packages/coding-agent/test/multi-agent-extension.test.ts`](../../packages/coding-agent/test/multi-agent-extension.test.ts)
  asserts the first extension-facing viewer/mailbox/spawn/list/wait/cancel/contact/steer
  tool surface is store-backed and does not start child model sessions by default. It also asserts
  recovered attached-session agents are restarted on `session_start` through the attached-session factory
  without treating old process handles as live, recovered agents are consumed so later reloads do not
  auto-prompt them again, idle waiting agents are not auto-prompted, child runtimes do not run supervisor
  recovery, shutdown aborts live child handles, and old dispatch completions cannot mutate a newly rebound store. It also asserts
  the spawn tool can call an injected child dispatcher, a real child `AgentSession` factory, or the
  production child factory wrapper, that configured agent profiles can select child model/thinking
  settings for `agentType: "explore"`, `agentType: "documentation-update"`, and `agentType: "implement"`, that `wait_agents({})` immediately consumes one pending completion notification, or one pending failure notification for a failed detached Pyrun job, or waits for any agent active at invocation to reach terminal state, returns that winner's completion or status, exposes the consumed agent and message in `details`, and marks the matching runtime mailbox transport row delivered. Failed agents expose their failure message and `fileRefs`. `list_agents` returns
  active agents by default and can return descendants below a parent without TUI state, and that `contact_supervisor` routes child messages to the direct parent with validated absolute
  file references. It verifies `agent_viewer` requires an agent ID, can read an
  agent from a persisted supervisor store via `storeSessionId`, and returns one
  agent's read-only snapshot, status, transcript, child IDs, and stop/steer command descriptor details without advancing lifecycle state. The
  read-only `agents_mailbox` tool is temporarily disabled; mailbox state is still maintained by core
  store APIs. It also verifies `send_agent_message` derives the sender from the current session instead of
  accepting caller-supplied sender/revision fields, allows direct parent-child mailbox messages
  while rejecting sibling targets. It verifies
  `createMultiAgentWorkflowOperations()` composes spawn/message/wait operations through
  `MultiAgentStore` without owning separate runtime state. It also asserts `/bg` registers a
  background job command, starts child-session prompt work without waiting for completion, and
  aborts a running background child session when the job is cancelled.
- [`packages/coding-agent/test/runtime-mailbox.test.ts`](../../packages/coding-agent/test/runtime-mailbox.test.ts)
  verifies explicit runtime mailbox mirroring and delivery for child completion, waiting-for-input,
  steering, and failed detached Pyrun notifications, including `wait_agents({})` delivery marking.
- [`packages/coding-agent/test/pyrun-extension.test.ts`](../../packages/coding-agent/test/pyrun-extension.test.ts)
  covers detached Pyrun completion and failure regressions, including `durationMs` and duration-bearing
  lifecycle notifications.
- [`packages/coding-agent/test/keybindings-migration.test.ts`](../../packages/coding-agent/test/keybindings-migration.test.ts)
  verifies the default `Alt+1` through `Alt+9` bindings for visible agent slot actions.

## Known gaps (current cycle)

- [x] Audit existing Pi subagent extensions and local Claude Code task primitives; record which
      behavior should be reused, adapted, or rejected.
- [x] Design the core authoritative agent state store, lifecycle revisions, mailbox commands, and
      read-only TUI projection contract.
- [x] Add the first failing tests for stale-revision rejection, read-only agent switching, mailbox
      steering acknowledgement, and core-derived active counts.
- [x] Add and implement store persistence tests for control-DB row persistence, automatic
      persistence after mutations, in-place production-store restore, empty-session clearing, and
      lifecycle-preserving restore of interrupted agents.
- [x] Add failing extension-tool tests for spawn/list/wait/cancel/steer over `MultiAgentStore`
      without spawning real child model sessions.
- [x] Implement extension-facing spawn/list/wait/cancel/steer tools over `MultiAgentStore`, update
      `docs/specs/multi-agent.md`, run targeted tests and `npm run check`.
- [x] Add and implement injected child-dispatcher tests behind `spawn_agent` plus terminal-state
      `wait_agents({})` behavior without TUI coupling.
- [x] Add and implement real child `AgentSession` factory tests behind `spawn_agent` and
      terminal-state `wait_agents({})` behavior without TUI coupling.
- [x] Implement production child `AgentSession` factory wiring for `spawn_agent` using existing
      session primitives, without real provider calls in tests.
- [x] Add and implement descendant-scoped `list_agents` coverage so parent sessions can list child
      trees without TUI state.
- [x] Add and implement child-to-supervisor mailbox contact without sibling access.
- [x] Add and implement mailbox and completion `fileRefs` with absolute-path validation.
- [x] Add and implement `wait_agents({})` behavior that consumes one pending terminal notification
      (completed or failed) or waits for the first terminal agent from the invocation's active set,
      returns that winner's terminal result, and consumes only its notification.
- [x] Add focused tests for stable agent metadata, optional pinned slots, and remaining lifecycle
      transitions before marking core runtime bullets.
- [x] Add focused tests for authoritative snapshot projection and stale-slot resync by agent ID
      before starting TUI viewer wiring.
- [x] Add first read-only `agent viewer` extension projection tests over core snapshots before
      wiring interactive TUI controls.
- [x] Add first `agents mailbox` extension projection tests for inbox/outbox summaries and
      acknowledgements over core mailbox state.
- [x] Add direct inter-agent mailbox message tests and the smallest sibling-safe send/list surface.
- [x] Add direct-file-reference tests for shared summaries/findings/log visibility outside mailbox
      payloads.
- [x] Add workflow-operation tests proving higher-level extensions can compose spawn/message/wait
      without owning separate runtime state.
- [x] Add focused account/policy inheritance tests for child agent model, account, budget, and
      narrowed permission metadata.
- [x] Add focused tests proving account metadata stays separate from mailbox/workflow state.
- [x] Add focused tests for terminal/subprocess worker adapter boundaries sharing core permission,
      mailbox, and lifecycle contracts.
- [x] Add focused tests for durable bounded transcript/event stream metadata across SessionManager
      persistence and projection snapshots.
- [x] Add focused TUI-facing projection tests proving core snapshots are authoritative for visible
      rows, pane slots, and stale conflict refresh.
- [x] Add focused `agent_viewer` tests for one-agent read-only status/transcript/child inspection plus
      explicit stop/steer command descriptors.
- [x] Add focused TUI slot-key tests for `Alt+1` through `Alt+9` switching visible agent slots
      without lifecycle mutation.
- [x] Add focused TUI slot persistence tests for stable bindings across list refreshes and pinned
      slot updates.
- [x] Move spawn/list/wait/cancel/steer workflow tools into an `agents-core`
      first-party extension package without moving authoritative state out of `MultiAgentStore`.
- [x] Move read-only tree/status/transcript projection and focus/switch command descriptors into
      an `agent-viewer` first-party extension package.
- [x] Move inbox/outbox summaries, acknowledgements, supervisor contact, and direct message actions into an
      `agents-mailbox` first-party extension package.
- [x] Keep compatibility tests proving the split modules share the same `MultiAgentStore` snapshot
      and do not create independent TUI/core state.
- [x] Move mailbox transport out of JSONL-backed `MultiAgentStore` snapshots and into a runtime
      SQLite mailbox keyed by `(session_id, agent_id)`.
- [x] Add idle polling and end-of-turn draining for the SQLite runtime mailbox so receivers wake
      without requiring `wait_agents`.
- [x] Add atomic claim/deliver/fail transitions for runtime mailbox rows and regression tests for
      duplicate delivery prevention across concurrent receivers.
- [x] Add 30-day cleanup for stale runtime mailbox rows.
- [ ] Add true mid-flight detach for the currently running foreground turn; the current `/bg`
      command starts a new background child-agent prompt instead of transferring an active
      in-progress `AgentSession` run.

## Out of scope

- Running child agents with broader permissions than the parent.
- Making cmux a required dependency.
- Treating workflow templates as the source of truth for lifecycle state.
