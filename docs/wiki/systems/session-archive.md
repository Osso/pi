# Session archive

Pi has these explicit archive surfaces:

- `/archive` accepts no arguments, archives only the current persisted session, and quits Pi. The archive runs during quit teardown so no later session write recreates the plain transcript.
- The resume picker archives the selected session when Ctrl+A is pressed.
- `pi sessions archive [--older-than <days>]` performs the age-based administrative bulk operation and reports its archived count.
- `pi sessions compress-archived [--dry-run]` migrates older metadata-archived plain JSONL files, excluding live resident Supervisor and Architect transcripts, and reports migrated, skipped, and failed sessions.

`/archive`, picker, and bulk-archived sessions persist archive metadata in the control database and store their transcripts as `.jsonl.zst`. Resuming one restores its `.jsonl` file and active metadata. Non-archived sessions remain plain `.jsonl`. The resident Supervisor and Architect transcripts are also metadata-archived, but remain plain `.jsonl` because their live runtimes append to them. A non-resident session abandoned without any message entry is removed at runtime teardown or replacement. On startup, Pi also removes only dead, fileless zero-message metadata rows left by interrupted processes; live, resident, archived, message-bearing, and recovery-persisted sessions are preserved. `pi sessions truncate-tool-output` is separate maintenance functionality and can rewrite session JSONL files; see [`session-tool-output.md`](session-tool-output.md). Archived sessions disappear from the normal Current Folder and All resume scopes and remain available in the Archived picker scope. The core session inventory is a non-archived main-session inventory: rows with `archived_at IS NOT NULL` or
`is_subagent = 1` are excluded regardless of `include_ended`, so child rows belonging to archived parents are
also absent; `broadcast` uses the same inventory. Archive writes remain targeted-row operations and do not
implicitly archive child rows. Archived scope preserves recent ordering instead of promoting named sessions, but still displays session names; Current Folder and All scopes continue to promote named sessions first.

`/delete` asks for confirmation, then quits Pi and, during quit teardown, deletes the current session and every child agent session recorded under it (by `parent_session_path` and `is_subagent`, recursively), using the `trash` CLI when it works and permanent deletion otherwise, and removes their metadata. The resume picker's Ctrl+D delete uses the same removal. `/delete` refuses while a child agent session is still running, since an aborted child keeps writing its transcript until it settles.

Session deletion resolves transitive descendants with one indexed lookup, invokes `trash` asynchronously in batches with bounded argument size, and retains permanent unlink when trash fails. One metadata-cleanup transaction covers only files actually deleted. The picker and `/delete` quit teardown await completion. This avoids per-file process startup and synchronous trash-process freezes.

`/archive`, `/delete`, and `/unarchive` report usage guidance when given arguments, report when the current session is not persisted, and report when no control database is available.

`/unarchive` clears only the current persisted session's archive metadata using the control-DB API. It leaves the active manager and transcript unchanged, with no picker, ID lookup, or session replacement. An already-unarchived session produces an informational notification without a metadata write. Compressed sessions are restored by the existing storage path when resumed, before becoming the current session.

## Automatic idle archival

`createAgentSessionRuntime` starts a non-blocking archival pass beside detached artifact cleanup. `idle-session-archive.ts` scans only `sessions/<project>/*.jsonl`; files strictly older than 30 days by filesystem mtime qualify. Residents and the starting runtime's path are excluded. Live `/proc` descriptor references, DB session listeners/health with present processes, nonterminal agent store/transcript paths, and runtime owners protect files. Ownership and file identity/size/mtime/ctime are checked again after streaming zstd compression and exact decompressed-byte comparison. A same-directory temporary file is atomically hard-linked to its final `.jsonl.zst` name without overwriting; existing archive relocation updates the control DB before removing the plain file. Failures are reported on stderr and temporary output is removed.

Automatic archives have the same visibility and restore semantics as manual ones. Read-only callers use `SessionManager.openReadOnly` or `session-transcript.ts`; they do not clear archive state. Writable resume/attach restore first. Literal old `.jsonl` references resolve to `.jsonl.zst` only when the plain file is missing. The seven repository stats/transcript scripts use the same decoding helpers. External reader deployment prerequisites are tracked in the [spec](../../specs/session-archive.md#known-gaps-current-cycle).

See [`docs/specs/session-archive.md`](../../specs/session-archive.md) for the contract and test coverage.
