# Speculative background compaction cache

Speculative background compaction prepares a compaction result before normal compaction must mutate the active session. The cache is session-local and must remain invisible until ordinary compaction commits it. The implementation lives in [`packages/coding-agent/src/core/agent-session.ts`](../../packages/coding-agent/src/core/agent-session.ts); its compaction preparation and generation reuse [`packages/coding-agent/src/core/compaction/compaction.ts`](../../packages/coding-agent/src/core/compaction/compaction.ts). The descriptive design belongs in [`docs/wiki/systems/speculative-background-compaction-cache.md`](../wiki/systems/speculative-background-compaction-cache.md).

## What it must do

### Cache lifecycle

- [x] Start at most one cache-only compaction when context reaches 70% of the model context window, including between tool calls in one active turn.
- [x] Keep background generation from appending session entries or mutating active agent messages/context.
- [x] Preserve a ready result for normal compaction instead of exposing it as a second context.

### Safe installation

- [x] When the cache is ready and the session has not advanced beyond its snapshot, trigger normal compaction immediately when idle.
- [x] When the session advances during generation, defer normal compaction until the active turn reaches its safe end point.
- [x] Preserve every entry appended after the cache snapshot verbatim when normal compaction commits.

### Validity and fallback

- [x] Reject a cache whose session, branch ancestry, model, compaction settings, or system prompt no longer matches the current session.
- [x] Prevent speculative generation from overlapping another speculative or real compaction.
- [x] Retain synchronous threshold and overflow compaction when the cache is unavailable, stale, canceled, or not ready.

## How it works

- [Speculative background compaction cache](../wiki/systems/speculative-background-compaction-cache.md)
- [Compaction & branch summarization](../../packages/coding-agent/docs/compaction.md)

## Implementation inventory

- `packages/coding-agent/src/core/agent-session.ts` — starts, validates, cancels, schedules, and consumes the session-local cache.
- `packages/coding-agent/src/core/compaction/compaction.ts` — prepares the snapshot and generates the reusable compaction result.

## Tests asserting this spec

- `packages/coding-agent/test/suite/agent-session-compaction.test.ts`
  - speculative trigger and single-flight behavior
  - mid-turn tool cycles start generation before `agent_end` and consume it at the safe turn end
  - no active-context mutation while generation is pending
  - idle cache consumption
  - post-snapshot entry preservation
  - stale branch rejection
  - synchronous fallback without overlapping compactions

## Known gaps (current cycle)

- None.

## Out of scope

- Changing compaction summary format or provider eligibility.
- Switching the active context from background work before normal compaction reaches a safe point.
- Replacing synchronous overflow recovery.
