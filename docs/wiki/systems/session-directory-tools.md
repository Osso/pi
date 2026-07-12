# Session directory and runtime liveness

`list_sessions`, `broadcast`, and Resident Architect snapshots share the runtime listener and
`session_health` state in `control.sqlite`. A live main session is identified by a fresh runtime
heartbeat, not by OS PID existence.

## Binding lifecycle

Each `AgentSession` registers only its own runtime mailbox listener address at startup and refreshes
it every 60 seconds: a main runtime uses `(session_id, NULL)` and a subagent uses
`(session_id, agent_id)`. Registration writes `ok` health for the same session/PID generation. A
PID change advances `agent_generation`; a heartbeat from the confirmed runtime sets
`checked_generation` to that current generation. Registration and teardown use the same exact
address, so a subagent never creates or retires a main-thread binding.

Only one main-session listener may own a PID. Registering a main listener freshly asserts its exact
session path, atomically deletes other main-session listener rows with that PID, and marks their
matching health rows `dead` with `pid = NULL`. Assertion trust requires the path assertion timestamp
to match the listener heartbeat; pathless or legacy timestamp-only heartbeats invalidate it. Session
switch, restart, fork, and disposal retire the old
listener through an exact
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
6. After listener/health synchronization, invoke recovery-leader reconciliation for candidate
   stores. Health and exact path assertions select candidates but do not authorize lifecycle writes.
   The recovery leader acquires fenced ownership and commits through coordinator/repository
   transactions. Generic owner loss resolves as `failed/lost_runtime`; uncertain process-backed,
   attached, queued, terminal, and current-live rows follow their explicit recovery policy.
7. Exclude every ended row when `includeEnded` is `false`.

`broadcast` selects recipients from the same reconciled current-binding inventory. Resident
Architect uses a bounded read-only SQL projection with the same requirements: main listener,
matching `ok` health generation, and health activity inside the five-minute freshness window.

## Root causes fixed

Child `AgentSession` runtimes previously registered both their own `(session_id, agent_id)` mailbox
listener and a false `(session_id, NULL)` main-thread listener. Registering that false main address
retired the real main binding on the shared PID. Architect then filtered the child metadata as a
subagent and temporarily saw neither session, until the main runtime heartbeat restored its binding.
The fix registers, heartbeats, and retires only the runtime's own address.

Separately, historical main-session listener rows were retained after session resume.
`listSessions()` then probed each stored PID and refreshed every row whose PID still existed.
Long-lived Pi processes and OS PID reuse therefore made old sessions appear live. Per-PID selection
in broadcast and Architect masked the symptom but did not repair global inventory.

The fixes make exact runtime-address ownership and heartbeat-backed bindings the identity proof,
retire bindings at lifecycle boundaries, and remove PID-only positive checks.

## Tests

- `packages/coding-agent/test/session-control-db.test.ts` — guarded listener retirement and health.
- `packages/coding-agent/test/runtime-mailbox.test.ts` — subagent listener registration preserves the
  same-process main-session binding.
- `packages/coding-agent/test/session-directory.test.ts` — unbound/stale PID regressions, ended
  filtering, current inventory, Architect agreement, and metadata deduplication.
- `packages/coding-agent/test/suite/agent-session-runtime.test.ts` — 60-second heartbeat freshness
  and resume-time listener retirement.
