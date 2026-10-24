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

The cross-process pass contract requires a nonblocking claim on the canonical existing sessions root before enumeration, held through the entire pass and released in `finally`. It reuses the installed `proper-lockfile` dependency, including stale-claim recovery after a crash; a competing startup skips rather than waits. This is pass ownership, not a per-transcript claim or control-DB schema change. Genuine I/O, corrupt-archive, and missing-data failures retain existing reporting and data-preservation semantics. Ownership uses `proper-lockfile`'s cooperative heartbeat and stale recovery, not OS fencing; a detected compromised claim stops publication and reports failure. See the [spec requirements](../../specs/session-archive.md#automatic-idle-archival).

`packages/coding-agent/test/idle-session-archive.test.ts` uses `packages/coding-agent/test/fixtures/idle-session-archive/race-worker.ts` to reproduce competing real Pi workers at source inspection (`lstat` `ENOENT`) and final hard-link publication (`EEXIST`), checking the winning archive's bytes and control-DB metadata.

Automatic archives have the same visibility and restore semantics as manual ones. Read-only callers use `SessionManager.openReadOnly` or `session-transcript.ts`; they do not clear archive state. Writable resume/attach restore first. Literal old `.jsonl` references resolve to `.jsonl.zst` only when the plain file is missing. The seven repository stats/transcript scripts use the same decoding helpers. External reader deployment prerequisites are tracked in the [spec](../../specs/session-archive.md#known-gaps-current-cycle).

## Bounded session opening

Current-version archived opens use the same active-slice loader as plain opens. The child-agent viewer, HTML/terminal exports, history-search input, and forks therefore receive the same loaded entries, context, and tree for either format; SQLite settings and goal references remain separate. `loadEntriesFromFile` still explicitly returns the full transcript.

The reverse scanner retains only active ancestors while locating the latest compaction and its preceding cwd marker, never summarized payloads or discarded branches. For an uncompacted tree with inactive branches, a second forward read preserves the original full-tree behavior; linear histories reuse the scanned path. Memory scales with retained state, read chunks, and the largest record, not the summarized prefix.

`session-transcript-spool.ts` bridges the synchronous manager API to the existing asynchronous zstd stream in a worker. A private temporary plain file permits the same reverse scan; success, decoding errors, and reader exceptions remove it without restoring the archive or changing metadata. Decompression has a 90-second completion bound; disk space proportional to decoded size is required. Full-entry/header archive readers share this bridge rather than allocating a complete decompressed Buffer.

`session-load-parity.test.ts` compares six complete state snapshots captured from the original plain loader at `af8182e1f`, plus caller outputs and SQLite metadata. `session-load-memory.test.ts` generates a 500+ MiB transcript and measures kernel peak RSS in fresh child processes, with a 256 MiB bound for both formats. For a pre-activation compiled-runtime check, run `node scripts/smoke-archived-session-open.mjs /path/to/compiled/pi`; it verifies the exported loaded entry IDs, unchanged archive, and empty temporary spool directory using isolated Pi paths.

See [`docs/specs/session-archive.md`](../../specs/session-archive.md) for the contract and test coverage.
