# Loop tool

The loop tool is a first-party coding-agent extension that schedules recurring follow-up prompts in the current session.

The durable behavior contract lives in [`../../specs/loop-tool.md`](../../specs/loop-tool.md).

## Runtime behavior

A loop waits for one full interval before its first tick. If the session is busy or has queued input, repeated ticks coalesce into one deferred delivery instead of adding copies. When the active run ends, that deferred delivery is released once if the loop is still active and no pending input must run first. Ticks that occur while the loop follow-up itself is in progress are skipped, keeping at most one loop prompt outstanding.

Stopping or replacing a loop clears its timer and cancels any deferred loop delivery. Session shutdown clears the timer and terminally closes that controller: a late model `start` is rejected rather than retaining session-bound extension context past disposal. Terminal spawned and attached child cleanup emits the same shutdown event before disposing the child session, so child-owned loop timers cannot outlive their extension context. Ordinary stop/restart behavior remains available until shutdown. Loop follow-ups retain `loop` provenance while keeping the configured prompt body unchanged; ordinary user follow-ups are unaffected.

Loop state remains session-local and is not restored across process restarts.

## Verification evidence

On September 8, 2026, a real-process faux-provider regression forced shutdown cleanup, a late model `start`, and disposal; the prior behavior reached the stale extension-context error. The fixed regression and loop suite passed 14/14 at `0ee797cef`. `deploy.sh` then completed with `npm run check` and installation; restarted installed-Pi sessions matched SHA-256 `d33e0689747f7aeba5ff181044d5df2e02f418fbe0c71419a2f6b311ebb5c206`. Independent verification passed the live-child process-restart case. After test-only predicate cleanup, both runtime tests and the full check passed again at `c9bf49364`; production code and deployed-artifact proof remained unchanged.

On September 13, 2026, regression `f8cc545d7` reproduced the same stale-context stack after a production child started a loop, completed, and was disposed without `session_shutdown`. Fix `74fbe26ce` makes spawned and attached child teardown await that event before disposal; `1243a6a75` repaired its test barrier. Independent proof passed the loop suites (14/14) and a live-child supervisor-restart case (1/1; `/tmp/pi-loop-verifier-report.md`). Follow-up `b179bc91a` extracted child-safe dispatch shutdown cleanup without changing behavior; its 146 regression tests and `deploy.sh` full check/build/install passed (`/tmp/pi-loop-refactor-tests.log`, `/tmp/pi-loop-deploy-refactor.log`). Installed SHA-256: `6e6adb86b28ebec5f3d614b6b27f607d77ece65e5304564e07a38dcd3fec8ba0`. Only eligible live main session `01a09920-be0c-7672-870a-fa5dc084c355` (PID 3945823) re-execed the installed `pi` launcher and returned `running`/`ok` with that executable hash (`/tmp/pi-loop-refactor-rollout-after.json`); installed `--help` exited 0 (`/tmp/pi-loop-refactor-installed-help.log`). The WoW session was not live and was not restarted. Final independent verification passed the live-child restart case and found no new or worsened readability violations across all seven `agents-core` source files (`/tmp/pi-loop-followup-verifier-report.md`); existing oversized/complex runtime debt remains outside this fix. This reproduction does not identify the original incident's exact trigger.
