# Session selector search

Module boundary: core interactive TUI.

The resume-session picker searches loaded session metadata and conversation text while retaining fuzzy fallback for incomplete queries.

## What it must do

### Search behavior

- [x] Search session IDs, names, user and assistant message text, and working directories.
- [x] Treat unquoted terms as case-insensitive fuzzy subsequence tokens.
- [x] Rank literal substring matches before subsequence-only fuzzy matches in Recent and Fuzzy sort modes.
- [x] Preserve existing order within the literal and fuzzy groups in Recent sort mode.
- [x] Treat quoted text as an exact phrase after whitespace normalization.
- [x] Support case-insensitive `re:<pattern>` regular-expression searches and reject invalid expressions.

### Session filtering

- [x] Exclude sessions with no messages.
- [x] Support filtering the picker to named sessions before applying the search query.

## How it works

- [`docs/wiki/systems/session-selector-search.md`](../wiki/systems/session-selector-search.md) describes query parsing and ranking.

## Implementation inventory

- `packages/coding-agent/src/modes/interactive/components/session-selector-search.ts` — query parsing, matching, filtering, and ranking.
- `packages/coding-agent/src/modes/interactive/components/session-selector.ts` — resume-picker UI and sort/filter controls.

## Tests asserting this spec

- `packages/coding-agent/test/session-selector-search.test.ts`

## Known gaps (current cycle)

None.

## Out of scope

- Session metadata indexing and transcript persistence.
- Semantic or vector search.
