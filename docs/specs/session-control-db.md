Session control DB is the global control channel for the coding-agent runtime.
It lets an outside harness submit one incoming prompt and read the last assistant
reply without changing the JSONL transcript format. Its multi-agent liveness integration is described
in [docs/wiki/systems/multi-agent.md](../wiki/systems/multi-agent.md) and
[docs/wiki/systems/session-directory-tools.md](../wiki/systems/session-directory-tools.md).

## What it must do

- [x] Store the configured control database at `$XDG_STATE_HOME/pi/control.sqlite`, or
  `~/.local/state/pi/control.sqlite` when `XDG_STATE_HOME` is unset.
- [x] `PI_CODING_AGENT_STATE_DIR` overrides the state root, so the configured database is
  `<PI_CODING_AGENT_STATE_DIR>/control.sqlite`.
- [x] Explicit directory arguments remain available and resolve to `<directory>/control.sqlite`
  for isolated internal and test databases.
- [x] Do not automatically fall back to or migrate a legacy control database from the agent config
  directory. Deployment moves the live database to the state-root path while all runtimes are stopped.
- [x] Open the control database with multi-consumer SQLite settings (WAL journal
  mode, busy timeout, NORMAL synchronous) so concurrent Pi sessions can read and
  write without exclusive-lock failures. Bun connections must finalize every
  prepared statement before close so polling runtimes do not retain database file
  descriptors or eventually block coordination through descriptor exhaustion.
- [x] Store incoming harness messages outside the JSONL transcript.
- [x] Claim only the newest pending incoming message and supersede older pending
  messages.
- [x] Allow a claimed incoming message to be marked completed after it is
  submitted to the agent.
- [x] Claim, release, fail, and deliver runtime-directed messages only on their canonical `multi_agent_mailbox_messages` row. Claims record exact process identity and are reclaimable only after that exact process dies.
- [x] Store only the latest assistant message for external readers.
- [x] Provide `pi control send`, `pi control restart --session-id <session-id>`,
  `pi control last`, and `pi control path` so harnesses and operators use the CLI
  instead of reading or writing SQLite directly. Session restart resolves the exact
  live session health row and signals its PID with `SIGHUP`.
- [x] Store named-session metadata in the control DB.
- [x] Store the current session cwd, model provider/model ID, and thinking level in the
      session metadata row. Resume and restart treat these values as authoritative; ordinary
      metadata snapshots preserve them when callers update unrelated fields, and model/thinking
      changes do not append new JSONL setting entries. Existing sessions without these values
      use configured defaults; no existing-session settings backfill runs.
- [x] Session-listing metadata is maintained incrementally: appended entries fold into a
      per-session accumulator (rebuilt only after wholesale entry replacement such as resume,
      branch, or new session), and entries that cannot change session metadata (custom entries,
      labels, compaction records) do not trigger a metadata write at all. Generic metadata
      snapshots never write `goal_json`; goal mutations use the dedicated goal writer so stale
      snapshots cannot overwrite newer active, paused, or completed state. Resident Architect and
      Supervisor transcripts omit accumulated message-search text from metadata because they are
      archived service histories, not resume-picker search targets; this prevents unbounded shared-DB rewrites.
- [x] Store multi-agent state as per-entity rows keyed by session path
      (`multi_agent_agents`, `multi_agent_runtime_owners`, `multi_agent_terminal_outbox`,
      `multi_agent_mailbox_messages`, `multi_agent_counters_v2`): one row upsert per mutation, restore
      selects the session's rows. Runtime ownership acquisition is transactional and stores the exact Linux
      process identity `(pid, /proc/<pid>/stat startTimeTicks)`; a live exact owner rejects replacement,
      while a dead identity permits takeover without timers, heartbeats, expiry, renewal, lease IDs, or
      fencing counters. Attached ownership acquisition preflights supervisor, agent, ownership, and
      process-liveness state read-only, returns an unchanged exact existing ownership without reserving the
      writer lock, and revalidates the supervisor, agent payload snapshot, and ownership snapshot before
      atomically taking over ownership and advancing the agent revision. Session-owned agents recover through
      the registered owning supervisor; startup also
      globally reconciles exact dead detached runners without a recovery-leader lease. Lifecycle mutations
      validate the agent, exact process ownership, and requested transition from read-only snapshots, and
      prepare any detached-cancellation payload before reserving the writer; the commit revalidates the exact
      agent snapshot and owner predicate, then atomically updates lifecycle state and persists the cancellation
      command. Steering mutations likewise validate the agent, exact ownership, transition, and sender/
      recipient listener identities before reserving the writer; the commit revalidates those snapshots and
      atomically updates the agent, allocates the message counter, and persists the canonical mailbox payload.
      Steering delivery validates the agent, exact ownership, transition, and canonical message payload before
      reserving the writer; the commit revalidates both payload snapshots and atomically updates the agent and
      message rows. Terminal mutation preflights exact ownership, replay identity, transition legality, and
      descendant state read-only; its commit revalidates the agent snapshot and owner predicate, recursively
      rechecks that no persisted descendant is nonterminal, and atomically persists the terminal agent and one
      outbox row. Detached-job finalization resolves the candidate session path from exact ownership rows and
      preflights path uniqueness, replay identity, terminal payload, lifecycle, ownership, and descendant state
      read-only. Its commit revalidates unique ownership, the agent snapshot, and recursive descendant absence in
      one CAS fence, then atomically persists the terminal agent, outbox row, and optional detached transport
      notification. Exact replays return the existing terminal result without reserving the writer. Lifecycle transactions read revision internally, verify session/agent/process ownership, update
      the agent row, and enqueue one pending completion notification in the same immediate SQLite transaction.
      The agent row is terminal truth; the outbox is only a delivery queue.
      Exact retries return the committed terminal revision without rewriting rows; conflicting predicates fail
      without creating another notification. Outbox rows use atomic single-claim delivery; failures return
      the same row to pending with an incremented attempt count and retained error, while successful delivery
      finalizes only notification transport. An idle outbox claim performs a read-only eligibility probe and
      returns without reserving the writer lock; when stale claims need recovery, that recovery remains in the
      immediate transaction, and the pending-row selection plus claim is one atomic `UPDATE ... RETURNING`.
      Child construction occurs before persistence: pure child payload, ID, lifecycle, parent-ID
      validation, and serialization complete before writer acquisition; parent lifecycle validation and
      uniqueness run as read-only preflight, while the commit revalidates the exact parent snapshot and
      atomically inserts the child and ownership rows. Failed-child persistence applies the same pre-lock
      boundary to payload/lifecycle/revision/parent-ID validation and serialization; its commit revalidates
      the exact parent snapshot and uniqueness before atomically inserting the failed child and terminal
      outbox rows. Success commits the child row as `running` revision 1 with ownership, while construction
      interruption or failure commits `failed` revision 1. Attachment payload, ID, origin, lifecycle,
      revision, and serialization complete before writer acquisition; parent lifecycle and permission
      validation plus uniqueness run read-only, while the commit revalidates the exact parent snapshot and
      atomically inserts the attachment. No persisted `queued` or `starting` startup row exists. Multi-agent
      activity, transcript, and slot metadata updates validate read-only, then use bounded exact-payload
      compare-and-swap writes; activity updates also require the exact persisted runtime owner in the
      update predicate. Detachment marking likewise validates lifecycle and exact ownership without
      waiting for an unrelated writer; a valid mark atomically sets `detached` and advances revision,
      while stale or foreign ownership rejects without side effects. Repeated identical transitions are
      idempotent. Concurrent SQLite contenders serialize, repository code reads/increments revision
      internally, and mismatched process ownership rejects without side effects. Legacy
      artifact tables/columns are not initialized, read, written, or relocated; the legacy
      `multi_agent_counters` table is only migrated into `multi_agent_counters_v2`.
- [x] Allocate persisted multi-agent agent and message IDs with one atomic incrementing upsert
      that returns the allocated value. Legacy counter rows are merged by maximum value during
      migration, then the legacy counter and artifact tables are dropped so relocated state cannot
      be resurrected or reuse IDs; concurrent allocators receive unique contiguous values without a
      read/increment/upsert race.
- [x] During schema initialization, perform an atomic, durable, one-time cleanup of legacy
      `artifactIds` and `artifactRefs` fields in persisted agent and mailbox payloads, rewrite cleaned
      rows, install schema-versioned SQLite INSERT/UPDATE triggers on both payload tables, and continue
      restoring supported state. Already-migrated opens skip the writer transaction and full-table scan;
      the triggers prevent older binaries from reintroducing legacy keys. Malformed rows remain stored
      for contextual restore validation.
- [x] Fence lifecycle writers by control-DB protocol version. A runtime rejects databases with a newer
      schema before initialization. Protocol activation scans listener, health, and exact runtime-owner
      process identities inside the migration transaction and refuses to upgrade while any verified Pi or
      detached runner remains active; legacy rows convert only after full runtime quiescence. No
      connection-local authorization UDF, trigger token, compatibility writer, or fallback mutation path
      exists; construction/source-scan tests keep production lifecycle calls behind `LifecycleCoordinator`
      plus the detached runner's narrow exact-owner finalizer from in-memory identity, outcome, and output
      metadata; output artifacts remain diagnostic only.
- [x] Stored runtime-mailbox enqueues prepare and validate payloads before writing. Existing duplicate or
      conflicting rows are handled read-only; absent rows use one conflict-safe insert and validate a
      concurrent winner without rewriting it.
- [x] Multi-agent mailbox upserts prepare parent-target authorization, collision validation, and
      canonical claim-preserving merges from read-only snapshots. Unchanged canonical rows return
      without reserving the writer lock; changed or inserted rows revalidate the exact parent and
      mailbox snapshots before one atomic upsert, retrying bounded snapshot conflicts explicitly.
- [x] Reject conflicting reuse of a persisted mailbox message ID transactionally: updates are allowed
      only when both stored and incoming identities are complete and the sender, recipient, kind,
      thread, and message ID identity match; incomplete or conflicting reuse fails explicitly without
      overwriting the existing row.
- [x] Store per-session health state (`session_health`) for heartbeat-backed liveness used by
      `list_sessions`, `broadcast`, and Architect snapshots, including agent generation and last
      heartbeat/check fields.
- [x] Provide exact-owner lifecycle transactions for session-owned orphan reconciliation. Session health
      and exact listener-path assertions identify the one owning supervisor; unrelated sessions do not
      elect or share a recovery leader. Mutations use the persisted owner session/agent plus exact process
      identity; revision is repository-managed and never supplied by tools. Verified administrative restart
      may commit an explicit interruption; confirmed exact owner-process exit commits `failed/lost_runtime`
      from `running` or `aborted/lost_runtime` from `cancelling`, never a direct JSON rewrite or inferred result. Attached, terminal, current-live,
      and uncertain process-backed rows follow their explicit recovery policy. Detached-runtime
      reconciliation prepares candidate and exact runner-liveness scans without reserving the writer
      lock, then revalidates each confirmed dead owner and commits one recovery at a time in a short
      immediate transaction; unrelated candidates remain eligible for later passes. Direct dead-runtime
      recovery applies the same boundary to one expected owner: supervisor authority, agent, owner,
      descendant, and process-liveness checks run read-only first. Commit-time CAS revalidates the
      persisted supervisor/listener authority, exact owner and agent snapshots, and recursive descendant
      absence before atomically releasing ownership and persisting terminal state, the outbox row, and any
      detached transport notification.
- [x] A main-thread listener registration persists its exact session path and assertion timestamp,
      atomically retires other main-session bindings for the same PID, marks their matching health
      rows ended and confirms the registered binding `ok`. Listener retirement removes only the
      `(session_id, agent_id, pid)` binding being disposed. A conflicting live owner fails with an
      actionable recovery message naming the PID and verified session cwd when available; it never
      guesses cwd.
- [x] Session-path relocation updates the main-listener path assertion in the same SQLite transaction
      as metadata, multi-agent rows, counters, and mailbox references, so no live-store mismatch is
      externally observable.
- [x] Store shared-channel messages and per-recipient cursors in `control.sqlite` so idle
      sessions can catch up from an append-only global coordination log.
- [x] `multi_agent_mailbox_messages` is the sole per-message runtime-delivery authority: each row owns payload, routing, claim identity, status, failure, and delivery acknowledgment. Runtime listener rows provide address resolution and wakeups only; no per-message runtime transport table exists. Schema migration folds valid legacy routing and terminal status into canonical rows, resets legacy claims to reclaimable pending state, and drops the legacy table without a compatibility path. Dead claimed-row recovery scans authority and claimant liveness without reserving the writer lock, then revalidates each candidate and resets it to `pending` in a short immediate transaction. Runtime routing returns unchanged canonical payloads from read-only state; changed payloads use bounded compare-and-swap retries and fail explicitly if contention prevents routing.
- [x] A recipient that is not ready for direct active-input delivery leaves canonical mailbox rows
      `pending` and does not read their payloads into runtime memory. Once ready, delivery evaluates
      eligibility without reserving the writer lock. Delivery and runtime-mailbox claim scans then
      revalidate exact listener/ownership authority and the observed canonical payload in short
      per-message transactions before atomic delivery or claim writes; already-claimed or direct
      terminal status transitions use single-statement compare-and-swap writes guarded by the
      observed payload and claimant identity. Selected payloads proceed directly to active session
      input without an intermediate volatile queue. `wait_agents({})`
      uses the same delivery boundary on a coordination wake and returns all currently pending
      deliverable runtime-mailbox inputs, preserving sender/body formatting. Restart before a
      per-message write leaves the messages pending and recoverable. If another turn starts while
      idle delivery waits for the turn-start lock, delivery rechecks the active state and steers
      the message instead of attempting a conflicting prompt. Terminal notifications for
      completed agents and detached jobs interrupt active model thinking after durable delivery,
      while active tool execution remains uninterrupted.
- [x] Store prompt history in the control DB so concurrent Pi sessions append
  without overwriting each other's prompt history entries.
- [x] Migrate legacy JSON prompt history into the control DB when DB prompt
  history is empty.
- [x] `/name <name>` names the current session and `/unname` removes that name.
- [x] Session restore lists show named sessions first in Current Folder and All
  scopes, including threaded restore mode; Archived scope preserves recent
  ordering; all scopes display session names and support clearing a selected
  session name from rename mode with an empty value.
- [x] On SIGHUP, restart the interactive process so startup can consume the
  control DB incoming message.

## How it works

- [docs/wiki/systems/multi-agent.md](../wiki/systems/multi-agent.md) — coordinator-owned startup
  recovery and persisted agent lifecycle.
- [docs/wiki/systems/session-directory-tools.md](../wiki/systems/session-directory-tools.md) —
  liveness synchronization followed by owning-session recovery.

## Implementation inventory

- `packages/coding-agent/src/core/session-control-db.ts` — global SQLite path and schema,
  incoming-message claim/complete API, canonical mailbox delivery and listener/health lifecycle,
  per-session cwd/model/thinking metadata, multi-agent rows and counters, prompt-history and
  session-metadata APIs, and
  persisted spawned-agent ghost reconciliation.
- `packages/coding-agent/src/core/sqlite.ts` — shared multi-consumer SQLite open
  configuration helper used by the control DB.
- `packages/coding-agent/src/core/tools/channel-post.ts` — built-in tool that appends to the
  shared channel.
- `packages/coding-agent/src/cli/control-command.ts` — `pi control` command
  parser and output.
- `packages/coding-agent/src/main.ts` — claims a pending incoming message before
  interactive startup and dispatches `pi control`.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — submits a
  claimed incoming message and records the latest assistant reply.
- `packages/coding-agent/src/core/self-restart.ts` — SIGHUP restart handoff keeps
  the resumed prompt list empty unless a caller explicitly provides a prompt.

## Tests asserting this spec

- `packages/coding-agent/test/session-control-db.test.ts`
- `packages/coding-agent/test/control-command.test.ts`
- `packages/coding-agent/test/custom-editor-history.test.ts`
- `packages/coding-agent/test/session-selector-rename.test.ts`
- `packages/coding-agent/test/self-restart.test.ts`
- `packages/coding-agent/test/interactive-mode-startup-input.test.ts`

## Known gaps (current cycle)

- [x] Wire SIGHUP startup consumption and last-message recording into
  interactive mode.
- [x] Move runtime-mailbox selection and delivery marking to the recipient readiness boundary and
      remove volatile follow-up queuing for mailbox messages.

## Out of scope

- JSONL transcript migration or JSONL control records.
- Full mailbox history beyond the newest pending incoming message and latest
  assistant reply.
