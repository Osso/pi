# Session archive

Pi has three explicit archive surfaces:

- `/archive` accepts no arguments and archives only the current persisted session.
- The resume picker archives the selected session when Ctrl+A is pressed.
- `pi sessions archive [--older-than <days>]` performs the age-based administrative bulk operation and reports its archived count.

All surfaces persist archive metadata in the control database. They do not move, rewrite, or delete session JSONL files. Archived sessions disappear from the normal Current Folder and All resume scopes and remain available in the Archived picker scope. The resident Architect transcript is a persisted non-subagent session under `<agent-dir>/architect-sessions/`; it is outside Current Folder's directory scope but participates in All and age-based archival.

`/archive` reports usage guidance when given arguments, reports when the current session is not persisted, and reports when no control database is available.

See [`docs/specs/session-archive.md`](../../specs/session-archive.md) for the contract and test coverage.
