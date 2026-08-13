# Loop tool

The loop tool is a first-party coding-agent extension that schedules recurring follow-up prompts in the current session.

The durable behavior contract lives in [`../../specs/loop-tool.md`](../../specs/loop-tool.md).

## Runtime behavior

A loop waits for one full interval before its first tick. If the session is busy or has queued input, repeated ticks coalesce into one deferred delivery instead of adding copies. When the active run ends, that deferred delivery is released once if the loop is still active and no pending input must run first. Ticks that occur while the loop follow-up itself is in progress are skipped, keeping at most one loop prompt outstanding.

Stopping or replacing a loop clears its timer and cancels any deferred loop delivery. Session shutdown performs the same cleanup. Loop follow-ups retain `loop` provenance while keeping the configured prompt body unchanged; ordinary user follow-ups are unaffected.

Loop state remains session-local and is not restored across process restarts.
