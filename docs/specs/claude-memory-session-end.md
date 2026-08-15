# Claude-memory session-end indexing

The first-party Claude-memory session-end extension launches detached transcript indexing for persisted main sessions during shutdown. It lives in [`packages/coding-agent/extensions/claude-memory-session-end/src/index.ts`](../../packages/coding-agent/extensions/claude-memory-session-end/src/index.ts).

## What it must do

### Shutdown behavior

- [x] Launch `claude-memory index-file` detached for a persisted main-session transcript without waiting for child completion.
- [x] Skip indexing for child-agent runtimes.
- [x] Skip indexing for ephemeral sessions without a session file.
- [x] Log launch failures without rejecting session shutdown.

## How it works

- [Session lifecycle hooks](session-lifecycle-hooks.md)
- [Claude-memory session-end indexing](../wiki/systems/claude-memory-session-end.md) (stub)

## Implementation inventory

- `packages/coding-agent/extensions/claude-memory-session-end/src/index.ts` — shutdown filtering, detached process launch, and failure logging.

## Tests asserting this spec

- `packages/coding-agent/test/claude-memory-session-end-extension.test.ts` — detached main-session indexing, child-agent exclusion, ephemeral-session exclusion, and launch-failure handling.

## Known gaps (current cycle)

- None.

## Out of scope

- Prompt enrichment, process deadlines, and enrichment child cleanup — see [`claude-memory-enrichment.md`](claude-memory-enrichment.md).
- Transcript parsing and indexing semantics inside the external `claude-memory` binary.
- Retry, fallback, or user-configurable session-end indexing behavior.
