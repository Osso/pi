# Loop tool

The loop tool is a first-party coding-agent extension that schedules recurring follow-up prompts in the current session.

The durable behavior contract lives in [`../../specs/loop-tool.md`](../../specs/loop-tool.md).

## Runtime behavior

A loop waits for one full interval before its first tick. If the session is busy or has queued input, repeated ticks coalesce into one deferred delivery instead of adding copies. When the active run ends, that deferred delivery is released once if the loop is still active and no pending input must run first. Ticks that occur while the loop follow-up itself is in progress are skipped, keeping at most one loop prompt outstanding.

Stopping or replacing a loop clears its timer and cancels any deferred loop delivery. Session shutdown clears the timer and terminally closes that controller: a late model `start` is rejected rather than retaining session-bound extension context past disposal. Ordinary stop/restart behavior remains available until shutdown. Loop follow-ups retain `loop` provenance while keeping the configured prompt body unchanged; ordinary user follow-ups are unaffected.

Loop state remains session-local and is not restored across process restarts.

## Verification evidence

On September 8, 2026, a real-process faux-provider regression forced shutdown cleanup, a late model `start`, and disposal; the prior behavior reached the stale extension-context error. The fixed regression and loop suite passed 14/14 at `0ee797cef`. `deploy.sh` then completed with `npm run check` and installation; restarted installed-Pi sessions matched SHA-256 `d33e0689747f7aeba5ff181044d5df2e02f418fbe0c71419a2f6b311ebb5c206`. Independent verification passed the live-child process-restart case. After test-only predicate cleanup, both runtime tests and the full check passed again at `c9bf49364`; production code and deployed-artifact proof remained unchanged. No new readability violations remained; existing registration-size and test-fixture-size findings were unchanged. This proves the forced lifecycle ordering is closed; it does not establish the timing of the reported session crash.
