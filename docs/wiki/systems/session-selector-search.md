# Session selector search

Contract: [Session selector search](../../specs/session-selector-search.md).

## Query path

The resume picker passes loaded `SessionInfo` rows and editor text to [filterAndSortSessions](../../../packages/coding-agent/src/modes/interactive/components/session-selector-search.ts). Search text concatenates session ID, name, first user message, and cwd; it is not full-transcript search.

Queries support:

- Plain terms: each must fuzzy-match as a case-insensitive subsequence using the TUI `fuzzyMatch` helper.
- Double-quoted phrases: literal substring matching after lowercasing and whitespace normalization.
- `re:<pattern>`: a JavaScript regular expression with the `i` flag. The prefix itself is lowercase and case-sensitive; empty/invalid patterns produce no matches.

An unclosed quote falls back to whitespace-separated fuzzy tokens, retaining quote characters. Tokens are conjunctive but can match different positions in the concatenated metadata; they need not appear in query order.

## Filtering and ranking

Zero-message sessions are removed first. The named-only filter requires a nonblank trimmed name. Empty queries retain incoming order after filtering.

Recent mode groups literal matches before fuzzy-only matches while retaining incoming order within each group. For plain multi-token queries, “literal” means the complete normalized query occurs contiguously: `foo bar` outranks `foo elsewhere bar`. Phrase-only matches are literal. Mixed phrase/fuzzy queries are not classified literal, preserving Recent input order.

Relevance mode groups by literal status, then ascending summed score, then modified time descending. Phrase/regex scores use match offset; fuzzy scores come from `fuzzyMatch`.

[session-selector.ts](../../../packages/coding-agent/src/modes/interactive/components/session-selector.ts) starts in Recent mode and cycles Recent → Fuzzy → Threaded using the configured sort binding. Threaded mode shows a tree only for an empty query; searching flattens rows and uses relevance sorting. Named filtering and sort controls use configurable [keybindings](../../../packages/coding-agent/docs/keybindings.md).

## Evidence and limits

[session-selector-search.test.ts](../../../packages/coding-agent/test/session-selector-search.test.ts) was inspected, not executed. Concrete fixtures cover phrase normalization, regex/error handling, contiguous-query priority, mixed queries, score/date ranking, empty sessions, and blank names.

No semantic search, metadata indexing, or transcript scanning occurs in this matcher. Listing authority belongs to [session control DB](session-control-db.md); the helper preserves the caller's Recent order rather than independently sorting by date.
