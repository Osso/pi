# Session archive

Pi has three explicit archive surfaces:

- `/archive` accepts no arguments and archives only the current persisted session.
- The resume picker archives the selected session when Ctrl+A is pressed.
- `pi sessions archive [--older-than <days>]` performs the age-based administrative bulk operation and reports its archived count.

All archive surfaces persist archive metadata in the control database. They do not move, rewrite, or delete session JSONL files. `pi sessions truncate-tool-output` is separate maintenance functionality and can rewrite session JSONL files; see [`session-tool-output.md`](session-tool-output.md). Archived sessions disappear from the normal Current Folder and All resume scopes and remain available in the Archived picker scope. Archived metadata is also excluded from core session inventory, so `list_sessions` never returns archived sessions and `broadcast` uses the same active inventory. Archived scope preserves recent ordering instead of promoting named sessions, but still displays session names; Current Folder and All scopes continue to promote named sessions first. The resident Architect transcript is a persisted non-subagent session under `<agent-dir>/architect-sessions/`; its metadata is archived at startup, so it remains available only in the Archived picker scope.

`/archive` reports usage guidance when given arguments, reports when the current session is not persisted, and reports when no control database is available.

See [`docs/specs/session-archive.md`](../../specs/session-archive.md) for the contract and test coverage.
