Session control DB is the global control channel for the coding-agent runtime.
It lets an outside harness submit one incoming prompt and read the last assistant
reply without changing the JSONL transcript format. Its multi-agent liveness integration is described
in [docs/wiki/systems/multi-agent.md](../wiki/systems/multi-agent.md) and
[docs/wiki/systems/session-directory-tools.md](../wiki/systems/session-directory-tools.md).

## What it must do

- [x] Store the single control database at `control.sqlite` under the agent
  directory.
- [x] Open the control database with multi-consumer SQLite settings (WAL journal
  mode, busy timeout, NORMAL synchronous) so concurrent Pi sessions can read and
  write without exclusive-lock failures.
- [x] Store incoming harness messages outside the JSONL transcript.
- [x] Claim only the newest pending incoming message and supersede older pending
  messages.
- [x] Allow a claimed incoming message to be marked completed after it is
  submitted to the agent.
- [x] Allow a claimed runtime mailbox transport row to be released back to pending when delivery races with an active prompt, enabling bounded redelivery and avoiding spurious failures during concurrent delivery attempts.
- [x] Store only the latest assistant message for external readers.
- [x] Provide `pi control send`, `pi control last`, and `pi control path` so
  harnesses use the CLI instead of writing SQLite directly.
- [x] Store named-session metadata in the control DB.
- [x] Session-listing metadata is maintained incrementally: appended entries fold into a
      per-session accumulator (rebuilt only after wholesale entry replacement such as resume,
      branch, or new session), and entries that cannot change session metadata (custom entries,
      labels, compaction records) do not trigger a metadata write at all.
- [x] Store multi-agent state as per-entity rows keyed by session path
      (`multi_agent_agents`, `multi_agent_dispatch_leases`, `multi_agent_recovery_leader`,
      `multi_agent_terminal_events`, `multi_agent_terminal_outbox`, `multi_agent_terminal_cursors`,
      `multi_agent_mailbox_messages`,
      `multi_agent_counters_v2`): one row
      upsert per mutation, restore selects the session's rows. Dispatch lease acquisition is
      transactional; live leases reject competing owners, expired takeover increments the durable
      fencing epoch, renewal and release require the exact lease/runtime/owner/epoch identity, and
      release preserves the epoch while clearing ownership. Recovery sweepers use a separate singleton
      lease with the same live-owner rejection, expiry takeover, monotonic fencing, exact renewal, and
      compare-release rules, preventing concurrent reconciliation leaders. Terminal lifecycle commits verify
      the stored revision and full lease/runtime/owner/fencing identity, then update the agent row and insert
      its immutable terminal event and pending outbox row in one immediate SQLite transaction. Exact
      retries return the committed terminal revision without rewriting rows; conflicting payloads or stale
      predicates fail without creating another event or outbox record. Nonterminal lifecycle CAS uses the
      same complete revision/lease/runtime/owner/fencing predicate; concurrent SQLite contenders serialize
      so exactly one increments the revision and every stale component rejects without side effects. Legacy artifact tables/columns are not
      initialized, read, written, or relocated; the legacy `multi_agent_counters` table is only
      migrated into `multi_agent_counters_v2`.
- [x] Allocate persisted multi-agent agent and message IDs transactionally. Legacy counter rows are
      merged by maximum value during migration, then the legacy counter and artifact tables are
      dropped so relocated state cannot be resurrected or reuse IDs.
- [x] During schema initialization, perform an atomic, durable, one-time cleanup of legacy
      `artifactIds` and `artifactRefs` fields in persisted agent and mailbox payloads, rewrite cleaned
      rows, install schema-versioned SQLite INSERT/UPDATE triggers on both payload tables, and continue
      restoring supported state. Already-migrated opens skip the writer transaction and full-table scan;
      the triggers prevent older binaries from reintroducing legacy keys. Malformed rows remain stored
      for contextual restore validation.
- [x] Fence lifecycle writers by control-DB protocol version. A runtime rejects databases with a newer
      schema before initialization, registers its supported lifecycle protocol as a connection-local
      SQLite function, and schema-versioned triggers reject `multi_agent_agents` inserts or updates from
      connections that lack the current protocol registration. Protocol activation scans listener and
      health ownership inside the migration transaction and refuses to upgrade while any verified Pi
      runtime remains active; legacy rows convert only after full runtime quiescence. This makes
      legacy/mixed-version lifecycle writes fail closed without a compatibility or fallback mutation path,
      while leaving non-lifecycle control-DB operations independent.
- [x] Reject conflicting reuse of a persisted mailbox message ID transactionally: updates are allowed
      only when both stored and incoming identities are complete and the sender, recipient, kind,
      thread, and message ID identity match; incomplete or conflicting reuse fails explicitly without
      overwriting the existing row.
- [x] Store per-session health state (`session_health`) for heartbeat-backed liveness used by
      `list_sessions`, `broadcast`, and Architect snapshots, including agent generation and last
      heartbeat/check fields.
- [x] Provide `abortInactiveSessionSpawnedAgents()` as the transactional global reconciliation API
      for persisted multi-agent rows: a store with matching `session_metadata` can abort active
      spawned agents when its `session_health.pid` is `NULL` or when its metadata path differs from
      the exact live path freshly asserted on the main runtime listener for that session ID. The
      assertion is trusted only when `session_path_asserted_at` matches the listener heartbeat;
      pathless or legacy timestamp-only heartbeats invalidate it and conservatively protect all
      duplicate paths until re-registration. Reconciliation preserves unrelated agent JSON,
      increments revision, clears worker
      metadata, writes `supervisor_restarted`, and is idempotent; attached, queued, terminal,
      missing-health, current live, and stale-but-process-backed timeout rows remain unchanged.
- [x] A main-thread listener registration persists its exact session path and assertion timestamp,
      atomically retires other main-session bindings for the same PID, marks their matching health
      rows ended, and confirms the registered binding `ok`;
      listener retirement removes only the exact `(session_id, agent_id, pid)` binding being
      disposed. A conflicting live owner fails with an actionable recovery message naming the PID
      and verified session cwd when available; it never guesses cwd.
- [x] Session-path relocation updates the main-listener path assertion in the same SQLite transaction
      as metadata, multi-agent rows, counters, and mailbox references, so no live-store mismatch is
      externally observable.
- [x] Store shared-channel messages and per-recipient cursors in `control.sqlite` so idle
      sessions can catch up from an append-only global coordination log.
- [x] Runtime mailbox transport rows never copy message bodies: `storeRef`
      (`store_session_path`, `store_message_id`) is required at enqueue, reads resolve
      body/absolute `fileRefs` payloads from `multi_agent_mailbox_messages`, and invalid legacy rows
      without a store reference remain rejected. Enqueue is idempotent per store reference (one
      transport row per store message); referenced payloads are covered by the one-time legacy-field
      cleanup above.
- [x] Store prompt history in the control DB so concurrent Pi sessions append
  without overwriting each other's prompt history entries.
- [x] Migrate legacy JSON prompt history into the control DB when DB prompt
  history is empty.
- [x] `/name <name>` names the current session and `/unname` removes that name.
- [x] Session restore lists show named sessions first, including threaded
  restore mode, and support clearing a selected session name from rename mode
  with an empty value.
- [x] On SIGHUP, restart the interactive process so startup can consume the
  control DB incoming message.

## How it works

- [docs/wiki/systems/multi-agent.md](../wiki/systems/multi-agent.md) — startup reconciliation and
  persisted agent lifecycle.
- [docs/wiki/systems/session-directory-tools.md](../wiki/systems/session-directory-tools.md) —
  liveness synchronization followed by global reconciliation.

## Implementation inventory

- `packages/coding-agent/src/core/session-control-db.ts` — global SQLite path and schema,
  incoming-message claim/complete API, runtime mailbox transport and listener/health lifecycle,
  per-session multi-agent rows and counters, prompt-history and session-metadata APIs, and
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

## Out of scope

- JSONL transcript migration or JSONL control records.
- Full mailbox history beyond the newest pending incoming message and latest
  assistant reply.
