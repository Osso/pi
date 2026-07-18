# Current session history search

Module boundary: core built-in tool + session manager.

`search_current_session_history` lets the model recover full information from the current persisted session's active branch after lossy context compaction.

## What it must do

### Search surface

- [x] Register `search_current_session_history` as a built-in tool active by default.
- [x] Search case-insensitively across searchable entries on the current active branch.
- [x] Include full matching content that compaction omitted from the model context and mark omitted entries as compacted.
- [x] Exclude entries that belong only to inactive branches.
- [x] Include a configurable number of neighboring searchable entries around each match.
- [x] Bound matching results with a limit and cursor-based pagination.
- [x] Reject ephemeral sessions without a persisted session file.

## How it works

- [`docs/specs/session-lifecycle-hooks.md`](session-lifecycle-hooks.md) documents the surrounding session lifecycle contract.
- [`docs/specs/compaction-length-retry.md`](compaction-length-retry.md) documents compaction behavior.

## Implementation inventory

- `packages/coding-agent/src/core/tools/search-current-session-history.ts` — validates search input, searches active-branch entries, and formats bounded results.
- `packages/coding-agent/src/core/tools/index.ts` — registers the built-in tool and enables it by default.
- `packages/coding-agent/src/core/session-manager.ts` — exposes full active-branch and compaction-aware entry projections.

## Tests asserting this spec

- `packages/coding-agent/test/search-current-session-history-tool.test.ts`

## Known gaps (current cycle)

- None.

## Out of scope

- Searching other, archived, or parent sessions.
- Searching inactive branches.
- Semantic or vector search.
- Mutating session history.
- Providing an ephemeral-session fallback.
