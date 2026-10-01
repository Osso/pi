# Current-session history search

[Contract](../../specs/current-session-history-search.md)

## Use and data flow

Call `search_current_session_history` with literal `query`, optional `context_entries` (0–10, default 0), `limit` (1–50, default 20), and a returned `cursor`. It is default-active in [`tools/index.ts`](../../../packages/coding-agent/src/core/tools/index.ts).

[`search-current-session-history.ts`](../../../packages/coding-agent/src/core/tools/search-current-session-history.ts) requires a session file, trims/rejects an empty query, and obtains `sessionManager.getBranch()`. It recursively collects strings from user-message content and compares locale-lowercased substrings. Assistant/tool/custom/summary content cannot produce matches.

Matches are paged in branch order. Cursor is a decimal offset into matching entries, not an entry ID or snapshot token. Neighbor windows use the filtered sequence of messages, custom messages, compactions and branch summaries; overlapping windows are deduplicated. Metadata-only entries do not count as neighbors.

Results contain full content, entry ID/timestamp/type/role, `matched`, and `compacted`. The latter means absent from `buildContextEntries()`, not a stored flag. Details include total/returned match counts and `nextCursor`; zero matches produce a short text result. [`session-manager.ts`](../../../packages/coding-agent/src/core/session-manager.ts) supplies both branch traversal and compaction-aware projection.

## Important implementation gap

The contract requires recovering full omitted active-branch content. This works for entries retained in the current manager before compaction, as the tool test demonstrates. On reopening a compacted current-version session, SessionManager loads only the retained active slice; `getBranch()` walks that in-memory map. The tool does not reload the complete disk transcript. Consequently pre-slice history after resume is unavailable: the full-history requirement is not implemented across that boundary, despite the spec's completed checkbox.

No cross-session, inactive-branch, semantic search or ephemeral fallback exists. Pagination does not freeze history between calls; result limits bound match count, not content bytes.

## Test evidence

Inspected, not run: [`search-current-session-history-tool.test.ts`](../../../packages/coding-agent/test/search-current-session-history-tool.test.ts) covers user-only literal matching, in-process compaction, neighbors, branch exclusion, two-page pagination, persistence rejection and registration. [`active-slice-load.test.ts`](../../../packages/coding-agent/test/session-manager/active-slice-load.test.ts) describes the separate reopen boundary; the search test does not cover full-history recovery after reopen.
