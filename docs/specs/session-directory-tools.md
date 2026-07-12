# Session directory tools

Module boundary: core built-in tools + session control DB.

`list_sessions` and `broadcast` let agents discover other Pi sessions by purpose and
liveness, then deliver a message only to eligible sessions. Implementation details live in
[`docs/wiki/systems/session-directory-tools.md`](../wiki/systems/session-directory-tools.md).

## What it must do

### Inventory surface

- [x] `list_sessions` is registered as a built-in tool and active by default.
- [x] `list_sessions` returns session id, pid, status, startedAt, lastActiveAt, name, goal, cwd,
      lastCheckedAt, checkStatus, checkLatencyMs, agentGeneration, checkedGeneration, and
      eligibleToReceive.
- [x] Session purpose prefers `/name` and active `/goal` objective text when present.
- [x] Live main-thread pids come only from current runtime mailbox listener bindings addressed
      `(session_id, null)` and are tracked per session with an agent generation token; an unbound
      historical session is never revived merely because another current session uses the same PID.
      Subagent `(session_id, agent_id)` listener bindings are not main-thread inventory candidates.
- [x] `list_sessions` retains at most one current main-session binding per PID, retires older
      same-PID listener rows, and marks their matching health rows ended.
- [x] `list_sessions` derives positive liveness only from fresh runtime heartbeats; PID existence
      alone can never revive a historical or stale binding.
- [x] `list_sessions` returns only one metadata row for each session ID; deterministic ordering by
      modified time, update time, and session path resolves duplicate historical rows.
- [x] With `include_ended: false`, `list_sessions` excludes every ended row.

### Heartbeat-backed health

- [x] Main-session registration and each 60-second runtime heartbeat write `ok` health for the
      bound session and current agent generation.
- [x] Only a non-future heartbeat no older than five minutes is fresh. Older, invalid, and
      future-dated bindings are checked conservatively. If the PID is gone or belongs to a non-Pi
      process, the binding is retired and marked ended. If the Pi runtime still exists, the listener
      and PID remain bound with `timeout` health: the session is ended and ineligible for delivery,
      but its spawned-agent store is not destructively reconciled. PID existence never restores `ok`
      health.
- [x] Session switch and disposal retire only the exact `(session_id, agent_id, pid)` binding, so
      an overlapping replacement process cannot be removed by stale teardown.
- [x] Registering a different PID for a session advances its agent generation; registration from a
      confirmed live runtime clears stale death for the bound generation.
- [x] Ended sessions are not eligible to receive messages.
- [x] After listener retirement and health synchronization, `list_sessions` invokes session-owned
      reconciliation for candidate persisted stores. Health/path metadata selects candidates only;
      lifecycle changes require the exact persisted owner process identity `(pid, startTimeTicks)`;
      repository transactions manage revision internally. Confirmed dead owners resolve as
      `failed/lost_runtime`, while uncertain live processes remain unchanged.

### Broadcast surface

- [x] `broadcast` is registered as a built-in tool and active by default.
- [x] `broadcast` accepts a required message and optional filters (`session_ids`, `cwd`, `name`,
      `status`).
- [x] Candidate sessions pass through the same eligibility/check pipeline as `list_sessions`.
- [x] Ended or stale-bound sessions are skipped without PID-based revival.
- [x] `broadcast` uses the same current main-session binding and deduplicated metadata inventory
      as `list_sessions`; historical session IDs sharing a PID are never targeted.

## How it works

- [`docs/specs/session-control-db.md`](session-control-db.md) owns the global control DB path and
  runtime mailbox transport used for delivery.
- [`docs/specs/multi-agent.md`](multi-agent.md) defines runtime mailbox delivery and listener
  lifecycle for session main threads.
- [`docs/wiki/systems/session-directory-tools.md`](../wiki/systems/session-directory-tools.md)
  describes binding cleanup, liveness checks, and metadata selection.

## Implementation inventory

- `packages/coding-agent/src/core/session-health.ts` — health TS types and pure sticky-check rules.
- `packages/coding-agent/src/core/session-directory.ts` — inventory assembly, checks, and broadcast
  delivery.
- `packages/coding-agent/src/core/session-control-db.ts` — `session_health` persistence and listener
  generation bookkeeping.
- `packages/coding-agent/src/core/tools/list-sessions.ts` — `list_sessions` tool.
- `packages/coding-agent/src/core/tools/broadcast.ts` — `broadcast` tool.
- `packages/coding-agent/src/core/tools/index.ts` — built-in tool registration.

## Tests asserting this spec

- `packages/coding-agent/test/session-health.test.ts`
- `packages/coding-agent/test/session-directory.test.ts`
- `packages/coding-agent/test/list-sessions-broadcast-tools.test.ts`
- `packages/coding-agent/test/session-control-db.test.ts`
- `packages/coding-agent/test/suite/agent-session-runtime.test.ts`

## Known gaps (current cycle)

- [x] Add session health persistence and sticky dead semantics.
- [x] Add `list_sessions` inventory tool.
- [x] Add `broadcast` fanout tool with eligibility filtering.

## Out of scope

- Slash-command/TUI session browser UX.
- Hardcoded bulk restart/pause/resume commands.
- Auto-organization policies beyond raw inventory fields.
