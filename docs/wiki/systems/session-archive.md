# Session archive

Pi has two explicit archive surfaces:

- `/archive [days]` reviews recent sessions. It defaults to a five-day window, accepts a positive numeric day override, archives clear completed non-subagent sessions, skips incomplete or live sessions, and reports counts.
- `pi sessions archive [--older-than <days>]` performs the older age-based administrative bulk operation and reports its archived count.

Both surfaces persist archive metadata in the control database. They do not move, rewrite, or delete session JSONL files. Archived sessions disappear from the normal Current Folder and All resume scopes and remain available in the Archived picker scope.

`/archive` determines completion from the recent message tail. A session must end with a substantive assistant response; a trailing user message, empty assistant response, or explicit unfinished-work status is not treated as complete. Active runtime listeners protect live sessions from archival.

See [`docs/specs/session-archive.md`](../../specs/session-archive.md) for the contract and test coverage.
