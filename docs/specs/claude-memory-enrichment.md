# Claude-memory enrichment

The first-party Claude-memory extension enriches each non-empty agent prompt with retrieved context from the `claude-memory enrich` process. It lives in [`packages/coding-agent/extensions/claude-memory-enrich/src/index.ts`](../../packages/coding-agent/extensions/claude-memory-enrich/src/index.ts).

## What it must do

### Process lifecycle

- [x] Allow an enrichment process to run for up to 75 seconds before terminating it.
- [x] Send `SIGTERM` at the deadline, wait up to 1 second for `close`, then send `SIGKILL` if needed.
- [x] Settle the enrichment request only after the child closes, so timed-out children are reaped before queued work advances.
- [x] Preserve caller-abort, spawn-error, nonzero-exit, and malformed-JSON handling without double settlement.

### Context

- [x] Insert non-empty `additionalContext` inside one `<claude_memory_enrich>` section in the returned system prompt.
- [x] Serialize concurrent enrichment processes through the existing FIFO queue.
- [x] Report timeout failures explicitly as `claude-memory enrich timed out after 75000ms`.

## How it works

- [Claude-memory enrichment](../wiki/systems/claude-memory-enrichment.md)

## Implementation inventory

- `packages/coding-agent/extensions/claude-memory-enrich/src/index.ts` — process execution, timeout lifecycle, queueing, parsing, and prompt insertion.

## Tests asserting this spec

- `packages/coding-agent/test/claude-memory-enrich-extension.test.ts` — FIFO queue, post-15-second success, deadline escalation, close ordering, and timeout reporting.
- `packages/coding-agent/test/claude-memory-enrich-real-child.test.ts` — real child process reaping after SIGKILL.

## Known gaps (current cycle)

- None.

## Out of scope

- Removing enrichment or queueing.
- Retry, fallback, or user-configurable timeout behavior.
- Process-group termination; `claude-memory` has no descendants.
