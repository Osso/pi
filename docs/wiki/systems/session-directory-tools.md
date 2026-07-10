# Session directory and runtime liveness

`list_sessions`, `broadcast`, and Resident Architect snapshots share the runtime listener and
`session_health` state in `control.sqlite`. A live main session is identified by a fresh runtime
heartbeat, not by OS PID existence.

## Binding lifecycle

`AgentSession` registers its main runtime mailbox listener at startup and refreshes it every 60
seconds. Registration writes `ok` health for the same session/PID generation. A PID change advances
`agent_generation`; a heartbeat from the confirmed runtime sets `checked_generation` to that current
generation.

Only one main-session listener may own a PID. Registering a main listener atomically deletes other
main-session listener rows with that PID and marks their matching health rows `dead` with `pid =
NULL`. Session switch, restart, fork, and disposal retire the old listener through an exact
`(session_id, agent_id, pid)` delete. The PID guard prevents stale teardown from deleting a binding
owned by a replacement process.

## Inventory reconciliation

`listSessions()` performs these steps:

1. Keep the newest listener per PID and retire older same-PID rows left by previous binaries or
   interrupted switches.
2. Keep one metadata row per session ID. `listSessionMetadata()` supplies deterministic
   `modified_at`, `updated_at`, then `session_path` descending order.
3. Synchronize `ok` health only from a non-future listener heartbeat no older than five minutes.
4. For an older, invalid, or future-dated binding, verify whether the PID still represents a Pi
   runtime. A missing or non-Pi process retires the binding. A still-existing Pi runtime retains its
   listener and PID with `timeout` health, remains ended/ineligible, and cannot have its active
   spawned rows reconciled from heartbeat age alone. PID evidence never restores `ok` health.
5. Mark health rows without a retained current binding ended.
6. After this listener/health synchronization, call global
   `abortInactiveSessionSpawnedAgents()`. It changes active spawned rows in stores with exact
   `session_metadata` and either explicitly ended `session_health.pid = NULL` or a non-current
   duplicate metadata path for the same session ID. The caller's exact current path is protected;
   attached, queued, terminal, missing-health, current live, and stale-but-process-backed timeout
   rows remain unchanged, so repeated calls are idempotent.
7. Exclude every ended row when `includeEnded` is `false`.

`broadcast` selects recipients from the same reconciled current-binding inventory. Resident
Architect uses a bounded read-only SQL projection with the same requirements: main listener,
matching `ok` health generation, and health activity inside the five-minute freshness window.

## Root cause fixed

Historical main-session listener rows were retained after session resume. `listSessions()` then
probed each stored PID and refreshed every row whose PID still existed. Long-lived Pi processes and
OS PID reuse therefore made old sessions appear live. Per-PID selection in broadcast and Architect
masked the symptom but did not repair global inventory.

The fix makes the runtime heartbeat the identity proof, retires bindings at lifecycle boundaries,
and removes PID-only positive checks.

## Tests

- `packages/coding-agent/test/session-control-db.test.ts` — guarded listener retirement and health.
- `packages/coding-agent/test/session-directory.test.ts` — unbound/stale PID regressions, ended
  filtering, current inventory, Architect agreement, and metadata deduplication.
- `packages/coding-agent/test/suite/agent-session-runtime.test.ts` — 60-second heartbeat freshness
  and resume-time listener retirement.
