# Session directory tools

Module boundary: core built-in tools + session control DB.

`list_sessions` and `broadcast` let agents discover other Pi sessions by purpose and
liveness, then deliver a message only to eligible sessions. Implementation details may live
in [`docs/wiki/systems/session-directory-tools.md`](../wiki/systems/session-directory-tools.md)
once needed.

## What it must do

### Inventory surface

- [x] `list_sessions` is registered as a built-in tool and active by default.
- [x] `list_sessions` returns session id, pid, status, startedAt, lastActiveAt, name, goal, cwd,
      lastCheckedAt, checkStatus, checkLatencyMs, agentGeneration, checkedGeneration, and
      eligibleToReceive.
- [x] Session purpose prefers `/name` and active `/goal` objective text when present.
- [x] Live main-thread pids come from runtime mailbox listener rows and are tracked per session
      with an agent generation token.

### Sticky health checks

- [x] Sessions are rechecked when checkStatus is `never`/`timeout`, or when an `ok` check and
      activity are older than 5 minutes.
- [x] A definitive dead check sets sticky `dead` for the current agent generation and is not
      rechecked until the generation advances.
- [x] Registering a new live main-thread listener for a session advances generation when the pid
      changes and clears sticky death for the new generation after a successful check.
- [x] Sticky-dead sessions are not eligible to receive messages.

### Broadcast surface

- [x] `broadcast` is registered as a built-in tool and active by default.
- [x] `broadcast` accepts a required message and optional filters (`session_ids`, `cwd`, `name`,
      `status`).
- [x] Candidate sessions pass through the same eligibility/check pipeline as `list_sessions`.
- [x] Sticky-dead sessions are skipped without re-probing.
- [x] Successful deliveries enqueue one runtime mailbox message to the main thread of each target
      session and return one per-session outcome. When historical metadata has multiple paths for
      the same session ID, `broadcast` uses the first/newest inventory entry before applying filters.

## How it works

- [`docs/specs/session-control-db.md`](session-control-db.md) owns the global control DB path and
  runtime mailbox transport used for delivery.
- [`docs/specs/multi-agent.md`](multi-agent.md) defines runtime mailbox delivery to session main
  threads.

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

## Known gaps (current cycle)

- [x] Add session health persistence and sticky dead semantics.
- [x] Add `list_sessions` inventory tool.
- [x] Add `broadcast` fanout tool with eligibility filtering.

## Out of scope

- Slash-command/TUI session browser UX.
- Hardcoded bulk restart/pause/resume commands.
- Auto-organization policies beyond raw inventory fields.
