# Periodic checks

Bundled first-party `periodic-checks` schedules report-only project audits from a host-private checklist. Source: `packages/coding-agent/extensions/periodic-checks/src/index.ts`. This ports the host extension without changing scheduler behavior. See [operation and configuration](../wiki/systems/periodic-checks.md).

## What it must do

### Opt-in and lifecycle

- [x] Load as a bundled first-party extension, without a user-level extension installation or remote-agent mapping. Expose `/periodic-checks` through normal extension command discovery; support disabling by inventory name `periodic-checks` through `disabledExtensions`.
- [x] On `session_start`, including reload, discover the current directory's Git root and its ignored, host-private `periodic-checks.md`. No checklist means no timer and no audit. Deployment never copies checklists; each host configures its own file.
- [x] Arm only main TUI or RPC sessions with a multi-agent store and active `spawn_agent` and `send_agent_message` tools. Exclude child sessions and unsupported runtimes.
- [x] Require Google OKF YAML frontmatter with nonempty string `type` and positive safe-integer `interval_seconds` in 1–2147483 seconds. Allow unknown fields. Missing, malformed, or invalid metadata raises an explicit error and disables scheduling; no fixed-interval fallback.
- [x] Read metadata only at start/reload. Wait the full configured interval before the first tick. Apply metadata edits or re-arm a restored checklist only after another start/reload. Stop the timer on shutdown or checklist removal detected at dispatch, including during a pending spawn.

### Commands

- [x] `/periodic-checks` and `/periodic-checks status` immediately notify `armed` or `disabled`, checklist path when known, active `interval_seconds` and relative next-run estimate when armed, or disabled reason otherwise. Other arguments show `Usage: /periodic-checks status|run`.
- [x] Compute remaining time at status invocation from the stored scheduled tick: `Next run: in N minutes`, singular `Next run: in 1 minute`, or `Next run: in less than a minute`. Round minutes up at or above 60 seconds; 90 seconds shows 2 minutes; due/overdue ticks use the subminute phrase. Show no absolute date or timezone.
- [x] Status remains immediate while main is busy or has pending messages, without an audit, abort, model turn, timer reset, re-arm, or metadata reread. Skipped ticks advance the scheduled boundary independently of child completion.
- [x] `/periodic-checks run` requests the same read-only audit immediately, including while main is busy or has pending messages. Do not reset/advance the regular countdown, reread metadata, or re-arm a disabled schedule.
- [x] Refuse manual duplicates during pending spawn or live audit. Warn with a reason for disabled schedules, missing/removed checklists, unavailable runtime/tools, or changed session/project identity.
- [x] Manual requests report `Periodic audit starting` before dispatch settlement, then `Periodic audit started` only for a non-error tool result with `details.dispatched: true`. Blocked, undispatched, rejected, or error results produce contextual `spawn_agent` diagnostics, never false success. The command waits for neither spawn settlement nor child completion; `started` means accepted dispatch, not findings delivery.

### Dispatch and audit policy

- [x] Scheduled/manual dispatch calls `spawn_agent` directly with a fresh-context `explore` child named `periodic-checks-audit`. Busy main and pending messages do not skip dispatch. Do not queue a model prompt, follow-up, or steering message asking main to spawn it.
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

Verified 2026-10-23: 11 targeted Vitest cases pass, including the complete ported Node scheduler/dispatch suite. Installed-Pi acceptance passes three tests covering manual/timer audits during held model/tool work and mailbox delivery, with private state and no provider network. Named disabling is verified through source-CLI discovery. Laptop, agent-server (osso/allison), and sandbox inventories identify both commands as bundled extensions; 11 live host sessions adopted Pi `dbc28f233` with executable SHA-256 `acea31899cfcf247f629414e6a42ae8742766e71060f789f6a2dc331969e1268`. A disposable sandbox TUI reports disabled status without a Git project; no sandbox checklist was installed.

## Known gaps (current cycle)

- [x] Record bundled discovery, scheduler behavior, installed-runtime delivery, named disabling, and deployment verification.

## Out of scope

- New scheduler behavior, offline execution, checklist distribution, host/project mappings, and automatic remediation.
