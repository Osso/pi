# Current-session history search

[Contract](../../specs/current-session-history-search.md)

## Use and data flow

Call `search_current_session_history` with literal `query`, optional `context_entries` (0–10, default 0), `limit` (1–50, default 20), optional inclusive ISO `since` and `until` bounds on `entry.timestamp`, and a returned `cursor`. Timestamps must include a full date/time and explicit `Z` or numeric timezone offset. It is default-active in [`tools/index.ts`](../../../packages/coding-agent/src/core/tools/index.ts). Child agents also get `search_parent_session_history` with the same parameters; it reads the direct parent's session file from `ctx.multiAgentStore.getPersistenceTarget()`. Neither tool accepts an arbitrary session selector.

For example, to find recent parent evidence:

```json
{"query":"delegation","since":"2026-11-01T00:00:00Z","until":"2026-11-02T00:00:00Z","limit":10}
```

[`search-current-session-history.ts`](../../../packages/coding-agent/src/core/tools/search-current-session-history.ts) requires a persisted session, rejects an empty trimmed query, and compares locale-lowercased literal substrings. Matching includes user/assistant text, tool-call names and nested arguments, tool results, custom messages, compaction summaries and branch summaries. Thinking, signatures and history-search calls/results do not match.

[`session-history.ts`](../../../packages/coding-agent/src/core/session-history.ts) traverses active-branch ancestors newest first, streaming persisted ancestors missing from the loaded manager without expanding model context. Archived transcripts are spooled to temporary disk for reverse traversal. Inactive branches remain excluded.

## Dates and pagination

Without dates, pages retain their existing oldest-first active-branch order and decimal match-offset cursor. With either bound, entries are filtered by their session-entry timestamp before match counting and pagination. Both endpoints are inclusive. Bounded pages return newest active-branch matches first. Invalid timestamps, impossible calendar dates and reversed ranges fail explicitly.

Bounded cursors are opaque and tied to the normalized query and effective date range. Reuse the query and bounds when requesting the next page; equivalent timezone representations refer to the same bound. A cursor from a bounded search cannot be used for an unbounded search or vice versa. Pagination does not freeze history between calls.

The limit caps matching entries, not content bytes or additional neighboring context. Neighbor windows use only searchable entries within the date range; overlapping windows are deduplicated. Metadata-only entries do not count as neighbors. Out-of-range entries cannot reappear as context.

Results contain full content, entry ID/timestamp/type/role and `matched`. Current-session results also contain `compacted`, meaning absent from `buildContextEntries()`, not a stored flag. Parent results omit it because the child does not load its parent's model context. Details include total/returned match counts and `nextCursor`; zero matches produce a short text result.

## Test evidence

- [`search-current-session-history-tool.test.ts`](../../../packages/coding-agent/test/search-current-session-history-tool.test.ts): conversational matching, exclusions, compaction/resume/archive parity, neighbors, inactive branches, legacy pagination, persistence and registration.
- [`search-session-history-date-bounds.test.ts`](../../../packages/coding-agent/test/search-session-history-date-bounds.test.ts): current/parent date bounds, inclusive endpoints, limits, validation and bounded pagination.
- [`child-parent-observation.test.ts`](../../../packages/coding-agent/test/suite/child-parent-observation.test.ts): the parent-history tool is exposed to a spawned child, not the parent runtime.
