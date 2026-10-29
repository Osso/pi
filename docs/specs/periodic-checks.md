# Periodic checks

Bundled first-party `periodic-checks` schedules report-only project audits from a host-private checklist. Source: `packages/coding-agent/extensions/periodic-checks/src/index.ts`. The scheduler remains opt-in; status can discover a checklist added after startup. See [operation and configuration](../wiki/systems/periodic-checks.md).

## What it must do

### Opt-in and lifecycle

- [x] Load as a bundled first-party extension, without a user-level extension installation or remote-agent mapping. Expose `/periodic-checks` through normal extension command discovery; support disabling by inventory name `periodic-checks` through `disabledExtensions`.
- [x] On `session_start`, including reload, discover the current directory's Git root and its ignored, host-private `periodic-checks.md`. No checklist means no timer and no audit. Deployment never copies checklists; each host configures its own file.
- [x] Arm only main TUI or RPC sessions with a multi-agent store and active `spawn_agent` and `send_agent_message` tools. Exclude child sessions and unsupported runtimes.
- [x] Require Google OKF YAML frontmatter with nonempty string `type` and positive safe-integer `interval_seconds` in 1–2147483 seconds. Allow unknown fields. Missing, malformed, or invalid metadata raises an explicit error and disables scheduling; no fixed-interval fallback.
- [x] Read metadata at start/reload, or when status discovers a checklist previously missing at startup. Wait the full configured interval from discovery before the first tick. Apply metadata edits to an armed schedule or re-arm a checklist removed from an armed schedule only after another start/reload. Stop the timer on shutdown or checklist removal detected at dispatch, including during a pending spawn.

### Commands

- [x] `/periodic-checks` and `/periodic-checks status` immediately notify `armed` or `disabled`, checklist path when known, active `interval_seconds` and relative next-run estimate when armed, or disabled reason otherwise. Other arguments show `Usage: /periodic-checks status|run`.
- [x] Compute remaining time at status invocation from the stored scheduled tick: `Next run: in N minutes`, singular `Next run: in 1 minute`, or `Next run: in less than a minute`. Round minutes up at or above 60 seconds; 90 seconds shows 2 minutes; due/overdue ticks use the subminute phrase. Show no absolute date or timezone.
- [x] Status remains available while main is busy or has pending messages, without an audit, abort, or model turn. Only when the timer is undefined and the cached disabled reason is `No checklist`, status retries startup discovery and arms a valid new checklist subject to the same runtime gates. An armed schedule retains its metadata and original countdown. Invalid-metadata startup, shutdown, and removed-previously-armed checklist states still require start/reload. Invalid newly discovered metadata raises an explicit error with no timer. Skipped ticks advance the scheduled boundary independently of child completion.
- [x] `/periodic-checks run` requests the same read-only audit immediately, including while main is busy or has pending messages. Do not reset/advance the regular countdown, reread metadata, or re-arm a disabled schedule.
- [x] Refuse manual duplicates during pending spawn or live audit. Warn with a reason for disabled schedules, missing/removed checklists, unavailable runtime/tools, or changed session/project identity.
- [x] Manual requests report `Periodic audit starting` before dispatch settlement, then `Periodic audit started` only for a non-error tool result with `details.dispatched: true`. Blocked, undispatched, rejected, or error results produce contextual `spawn_agent` diagnostics, never false success. The command waits for neither spawn settlement nor child completion; `started` means accepted dispatch, not findings delivery.

### Dispatch and audit policy

- [x] Scheduled/manual dispatch calls `spawn_agent` directly with a fresh-context `explore` child named `periodic-checks-audit`. Busy main and pending messages do not skip dispatch. Do not queue a model prompt, follow-up, or steering message asking main to spawn it.
- [ ] Verify the current Git project root before scheduled dispatch. If the root check fails or times out, report the failure and skip that audit without terminating Pi or disabling later ticks.
- [x] Pending spawn suppresses overlap until settlement, including rejection or unsuccessful dispatch. A stored child named `periodic-checks-audit` blocks overlap until `completed`, `failed`, or `aborted`, including restored children after reload. Unrelated children do not block dispatch.
- [x] Child termination permits the next scheduled tick, not immediate dispatch; main `agent_end` does not release overlap. Reload/shutdown/replacement fence late spawn results from new pending locks and diagnostics. Dispatch failures notify explicitly with session, checklist, and failure context.
- [ ] Each audit rereads the checklist, limits findings to its requested scope, and reports missing checklist or unavailable evidence. Send findings through `send_agent_message` to `main` with the originating parent session ID; inspect the result and report delivery failure explicitly.
- [x] Audit instructions prohibit corrections, nested spawning, builds, cleanup, blocking, cancellation, steering, edits, deployment, operational mutation, or restarting main. Authorized main work continues independently.

## How it works

- [Configuration, commands, and scheduling](../wiki/systems/periodic-checks.md).
- [Extension settings](../../packages/coding-agent/docs/settings.md).
- [Multi-agent contract](multi-agent.md).

## Implementation inventory

- `packages/coding-agent/extensions/periodic-checks/src/index.ts` — checklist discovery, metadata validation, scheduling, status/manual commands, direct dispatch, and report-only audit prompt.
- `packages/coding-agent/src/main.ts` — first-party registration.

## Tests asserting this spec

- `packages/coding-agent/test/cli-runtime-inventory.test.ts` — first-party extension and command inventory, including bundled periodic-checks and exit-command.
- `packages/coding-agent/test/periodic-checks-extension.test.ts` — runs the ported native Node scheduler suite against the bundled source.
- `packages/coding-agent/test/fixtures/periodic-checks/test_periodic_scheduler.mjs` — metadata, discovery, timing, status, and manual-run behavior.
- `packages/coding-agent/test/fixtures/periodic-checks/periodic_scheduler_dispatch.mjs` — direct dispatch, overlap, busy/pending commands, failure feedback, and late-result fencing.
- Remote-agent `tests/test_periodic_runtime.py` with `tests/fixtures/periodic-runtime-provider.ts` — installed-Pi integration acceptance using private state and an offline faux provider, without explicit extension injection.

Verified 2026-10-23 at `16291d6a5`: all 122 native scheduler/dispatch tests pass, including late checklist creation, metadata failures, preserved countdowns, and runtime gates. Deployment check/build passes; independent verification confirms behavior and scoped readability. In the actual resumed Clank session, `/periodic-checks` reports `armed`, checklist `/workspace/wowdecomp/periodic-checks.md`, `interval_seconds: 600`, and `Next run: in 10 minutes` while main work continues. No manual audit was triggered. The sandbox and all 12 live host main sessions adopted executable SHA-256 `6fe054bd291d20ac89e621fe6076a02acfad1edc9caa82822c9b94380b1e2799`. Earlier bundling acceptance also verified command discovery, named disabling, exit shutdown, and three installed-runtime delivery tests.

## Known gaps (current cycle)

- [x] Record bundled discovery, scheduler behavior, installed-runtime delivery, named disabling, and deployment verification.

## Out of scope

- File watching, offline execution, checklist distribution, host/project mappings, and automatic remediation.
