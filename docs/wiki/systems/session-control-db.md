# Session control database

Contract: [Session control DB](../../specs/session-control-db.md).

## Storage boundary

[session-control-db.ts](../../../packages/coding-agent/src/core/session-control-db.ts) owns SQLite schema and repository operations. `getControlDbPath()` appends `control.sqlite` to the state root from [config.ts](../../../packages/coding-agent/src/config.ts): `PI_CODING_AGENT_STATE_DIR`, otherwise `$XDG_STATE_HOME/pi`, otherwise `~/.local/state/pi`. An explicit directory gives an isolated database. There is no automatic agent-config-directory migration.

[sqlite.ts](../../../packages/coding-agent/src/core/sqlite.ts) selects Node/Bun SQLite and configures WAL, NORMAL synchronous, and a 5-second busy timeout. Repository calls open/close connections unless retained by a runtime; retained calls finalize Bun statements after the outermost call. Coupled writes use immediate transactions. Initialization rejects schema versions above 15. Lifecycle-protocol and name migrations check runtime quiescence before writer acquisition and revalidate the snapshot inside the transaction; validated same-PID restart can exempt only its own process.

## Data flow

- **Harness input:** [control-command.ts](../../../packages/coding-agent/src/cli/control-command.ts) implements `send`, `restart --session-id`, `last`, and `path`. `send` enqueues globally, optionally signaling a PID with `SIGHUP`. [main.ts](../../../packages/coding-agent/src/main.ts) claims only the newest pending input for interactive startup, atomically superseding older pending rows. [InteractiveMode](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) marks it completed after `prompt()` resolves, or failed on rejection. [AgentSession](../../../packages/coding-agent/src/core/agent-session.ts) writes nonblank assistant text to the singleton `last_message` row.
- **Session metadata:** [SessionManager](../../../packages/coding-agent/src/core/session-manager.ts) folds appended entries into an accumulator and writes bounded listing metadata, not accumulated transcript text. SQLite owns current cwd/model/thinking, names, archive/subagent fields, and dedicated goal state. Generic snapshots preserve name/settings and do not write goals. Names distinguish never named (`NULL`), explicitly cleared (`''`), and nonempty titles; legacy JSONL names are ignored. Version 15 moves matching legacy `named_sessions` values into metadata and drops that table.
- **Listing/history:** nonempty metadata is authoritative for resume scopes, excluding child and resident histories. Transcript indexing occurs only when metadata is empty. Prompt history appends in SQLite; trimmed legacy JSON history is imported only into an empty history table.
- **Coordination:** per-session-path agent, exact process-owner, terminal-outbox, counter, and canonical mailbox rows back [multi-agent lifecycle](multi-agent.md). `multi_agent_mailbox_messages` owns routing/claim/delivery state; listeners supply addresses/wakeups, not a second message store. Health rows track generations/checks. [Shared channel](shared-channel.md) uses separate append-only messages and recipient cursors. Resident request tables serve [Architect](architect-service.md) and [Supervisor](supervisor-service.md) protocols.

JSONL remains conversation storage; control state is not a replacement transcript.

## Mailbox lookup and retention

[agents-core runtime.ts](../../../packages/coding-agent/extensions/agents-core/src/runtime.ts) uses
`listRuntimeMailboxMessagesForSession()` for terminal duplicate lookup across all recipients/statuses
in the exact owning `session_path`. Sender, `system` kind, parsed terminal body type, agent ID, and
terminal revision matching are unchanged. Core retains `listRuntimeMailboxMessages()` for global
administrative listing.

`session-control-db.ts` indexes a creation-time expression over canonical payload `createdAt`, with
missing/unparseable values ordered as expired. Initialization and one unref'ed 60-second timer per
retained connection run cleanup; final release cancels the timer. Cleanup probes read-only and, when
due, deletes all expired canonical rows in one statement, without a batch limit. Age never uses
`updated_at`; the [retention contract](../../specs/session-control-db.md#what-it-must-do) defines its
boundary and storage exclusions.

Freshness predicates gate reads, restore, claims, and delivery CAS writes between cleanup ticks.
Stale upserts skip persistence; stale enqueues fail explicitly. Updates preserve original creation time.
[MultiAgentStore](../../../packages/coding-agent/src/core/multi-agent-store.ts) excludes expired
messages from exposure, consumption, restore, and projection; terminal retries do not reemit old
agent notifications based on `agent.updatedAt`.
[AgentSession](../../../packages/coding-agent/src/core/agent-session.ts) prunes the memory projection
when draining runtime coordination.

New missing/null `createdAt` defaults to now at creation: TypeScript enqueue preparation stamps
new envelopes; upsert stamps only absent rows. Existing birth remains immutable. Enqueue's private
`defaultedBirth` flag excludes only generated birth from retry comparison; explicit dates retain
collision checks. An INSERT-only SQLite trigger, installed after migrations without a schema bump,
stamps valid-JSON legacy-new missing/null envelopes using UTC now independently of `updated_at`.
It never backfills preexisting rows or repairs UPDATEs. Existing unknown births still expire;
supplied invalid/stale dates never default.

Explicit producer timestamps remain at construction: status requests/responses in
`detached-job-control.ts` and Pyrun requests/responses in `extensions/pyrun/src/detached-bridge.ts`.
`buildDetachedCancellationMessage` uses `input.updatedAt`, the cancellation mutation's creation
clock, not a fallback from the old agent row. Payloads, routing, duplicate identity, and exact
runner ownership are unchanged.

Behavioral evidence:

- [runtime-mailbox-retention.test.ts](../../../packages/coding-agent/test/runtime-mailbox-retention.test.ts): creation defaults, immutable birth, invalid/stale exclusion, cleanup and writer fences. A retained Python sqlite3 producer inserts an undated envelope after parent restart; legacy SQL and new API envelopes remain claimable without rerunning the live job. This proves the legacy INSERT boundary, not an archived bridge binary.
- [runtime-mailbox-scope.test.ts](../../../packages/coding-agent/test/runtime-mailbox-scope.test.ts) and [runtime-lifecycle-mirror-scope.test.ts](../../../packages/coding-agent/test/runtime-lifecycle-mirror-scope.test.ts): exact-session lookup and lifecycle delivery.
- [multi-agent-mailbox-retention.test.ts](../../../packages/coding-agent/test/multi-agent-mailbox-retention.test.ts) and [agent-jsonl-restart.test.ts](../../../packages/coding-agent/test/suite/regressions/agent-jsonl-restart.test.ts): projection expiry and real-process restart preservation.
- [detached-status-retention.test.ts](../../../packages/coding-agent/test/suite/detached-status-retention.test.ts): status exchange and coordinator cancellation after parent restart with the job still live.

Verified 2026-10-08: merged integration and default-birth source gates passed separately.
Revision `749bc4f1c` deployed to both hosts through `deploy.sh --agent-server`; final inventory
found all eight eligible local mains and the resident current, no eligible remote mains or residents,
and zero expired/invalid-birth mailbox rows with creation indexes present on both hosts.
Stale health ghosts were excluded; existing detached runners were preserved. No user history was pruned.
Both hosts now have the same peer-descendant artifact; exact peer source-to-artifact confirmation
remains pending. Deployment does not expand test proof to unrelated descendant changes.

## Limits and evidence

Harness input is global, not addressed to the PID supplied to `send`; another interactive startup can claim it. `last` is likewise global. `restart` checks the exact session ID's health row for a PID and `checkStatus=ok`, then signals it; this CLI path does not independently validate process start identity. Do not confuse that check with exact-owner mailbox/lifecycle validation.

Test source inspected, not executed:

- [session-control-db.test.ts](../../../packages/coding-agent/test/session-control-db.test.ts), [session-name-schema-migration.test.ts](../../../packages/coding-agent/test/session-name-schema-migration.test.ts), [supervisor-request-repository.test.ts](../../../packages/coding-agent/test/supervisor-request-repository.test.ts): storage, claims, migration fences, names, and cancellation.
- [file-operations.test.ts](../../../packages/coding-agent/test/session-manager/file-operations.test.ts), [active-slice-load.test.ts](../../../packages/coding-agent/test/session-manager/active-slice-load.test.ts), [session-active-slice-restart.test.ts](../../../packages/coding-agent/test/suite/regressions/session-active-slice-restart.test.ts): metadata authority and restore/relocation boundaries.
- [control-command.test.ts](../../../packages/coding-agent/test/control-command.test.ts), [interactive-mode-startup-input.test.ts](../../../packages/coding-agent/test/interactive-mode-startup-input.test.ts), [self-restart.test.ts](../../../packages/coding-agent/test/self-restart.test.ts): CLI/startup handoff.
- [custom-editor-history.test.ts](../../../packages/coding-agent/test/custom-editor-history.test.ts), [startup-session-name.test.ts](../../../packages/coding-agent/test/startup-session-name.test.ts), [3686-session-name-event.test.ts](../../../packages/coding-agent/test/suite/regressions/3686-session-name-event.test.ts): history and naming persistence/events.
- [session-selector-rename.test.ts](../../../packages/coding-agent/test/session-selector-rename.test.ts), [interactive-mode-session-rename.test.ts](../../../packages/coding-agent/test/interactive-mode-session-rename.test.ts): picker controls and active name synchronization.
