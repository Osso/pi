# Current session history search

Module boundary: core built-in tool + session manager.

`search_current_session_history` lets the model recover full matching conversational content from the current persisted session's active branch after lossy context compaction.

## What it must do

### Search surface

- [x] Register `search_current_session_history` as a built-in tool active by default.
- [x] Search case-insensitively across user messages, assistant text, assistant tool-call names and arguments, tool results, custom messages, compaction summaries, and branch summaries on the current active branch.
- [x] Exclude the tool's own `search_current_session_history` calls and results from matching, while allowing other content in the same assistant message to match.
- [x] Exclude thinking blocks and content signatures from matching.
- [x] Include full matching content that compaction omitted from the model context and mark omitted entries as compacted, including after reopening or resuming the session.
- [x] Preserve the original in-process manager's search scope, chronological order, neighboring entries, and cursor pagination for plain and archived (`.jsonl.zst`) transcripts.
- [x] Stream earlier active-branch ancestors for search without installing them in the manager or expanding the compacted model context. Archived ancestors may be decompressed to a temporary disk spool, removed after traversal.
- [x] Return optional neighboring searchable entries around matches, regardless of entry type.
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
- `packages/coding-agent/src/core/session-manager.ts` — exposes loaded active-branch and compaction-aware entry projections.
- `packages/coding-agent/src/core/session-history.ts` — traverses loaded entries and streams missing persisted ancestors, newest first, following parent IDs.

## Tests asserting this spec

- `packages/coding-agent/test/search-current-session-history-tool.test.ts`

## Known gaps (current cycle)

- None.

## Out of scope

- Searching other or parent sessions (an archived transcript backing the current session remains searchable).
- Changing the session loader's existing peak-memory behavior; streaming here applies to search's additional historical traversal.
- Searching inactive branches.
- Semantic or vector search.
- Mutating session history.
- Providing an ephemeral-session fallback.
