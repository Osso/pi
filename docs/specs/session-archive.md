Module boundary: first-party extension module (`packages/coding-agent/extensions/session-archive/`) plus core session-control-DB archive state and resume-picker behavior.

Sessions archived through `/archive`, the resume picker, or `pi sessions archive` are stored as `.jsonl.zst` files and tracked in control-DB metadata. Resuming one restores plain `.jsonl` storage and active metadata. Each resident role has exactly one metadata-archived Supervisor or Architect transcript, which remains plain `.jsonl` because its live runtime appends to it; opening a role reuses its live transcript when present, otherwise reuses the latest resident transcript, and prunes only inactive stale transcripts and metadata. Resident histories are excluded from every resume-picker scope, including Archived. Non-resident sessions abandoned with no messages are removed at runtime teardown or replacement; startup also removes dead, fileless zero-message rows left by interrupted processes. The first-party `/archive` command accepts no arguments, archives only the current persisted session, and quits Pi. `/delete` confirms, then deletes the current session and its child agent sessions and quits Pi. The resume picker archives the selected session with Ctrl+A and deletes it, with its child agent sessions, with Ctrl+D. The separate `pi sessions archive` CLI command remains an age-based administrative bulk operation. `pi sessions compress-archived [--dry-run]` is a one-time migration for older metadata-archived plain JSONL transcripts; it excludes live resident Supervisor and Architect transcripts and reports migrated, skipped, and failed sessions. `pi sessions truncate-tool-output` is a separate maintenance command that may rewrite session JSONL files; see [`session-tool-output.md`](session-tool-output.md).

## What it must do

### Archive state and picker

- [x] Persist an archive timestamp in control-DB session metadata.
- [x] Store sessions archived through `/archive`, the picker, or bulk archival as `.jsonl.zst` files.
- [x] Restore an archived session to plain `.jsonl` storage and active metadata when it is resumed.
- [x] Keep non-archived sessions and the sole live transcript for each resident Supervisor and Architect role as plain `.jsonl` files; opening a role preserves its live transcript, otherwise reuses the latest resident transcript, and prunes only inactive stale transcript files and metadata.
- [x] Remove abandoned non-resident zero-message sessions at runtime teardown or replacement, and sweep only dead, fileless zero-message rows at startup.
- [x] Preserve live, resident, archived, message-bearing, and recovery-persisted sessions during empty-session cleanup.
- [x] Hide archived sessions from normal session metadata listings used by Current Folder and All resume scopes.
- [x] Exclude `archived_at` and `is_subagent` metadata from the core non-archived main-session inventory, so
      `list_sessions` never returns archived or child sessions regardless of `include_ended`; this also removes
      child rows belonging to archived parents. Archive writes remain targeted-row operations and do not
      implicitly archive child rows; `broadcast` inherits the same inventory.
- [x] Expose non-resident archived sessions through a dedicated Archived resume-picker scope (`session-selector-path-delete.test.ts`).
- [x] Exclude resident Supervisor and Architect transcripts from Current Folder, All, and Archived resume-picker scopes.
- [x] Preserve recent ordering in Archived scope instead of promoting named sessions, while displaying session names (`session-picker-selection.test.ts`).
- [x] Archive the selected picker session when Ctrl+A is pressed (`session-selector-path-delete.test.ts`).

### Automatic idle archival

- [x] Allow only one cross-process automatic archival pass per canonical existing sessions root; claim before enumerating candidates, protect the entire pass, and skip immediately when another pass owns it. Release ownership even on failure; abandoned crash claims must be recoverable.
- [x] Prevent competing startup passes from producing source-`lstat` `ENOENT` or archive-hard-link `EEXIST` errors while preserving the winning archive's bytes and control-DB metadata. Genuine I/O, corrupt-archive, and missing-data errors remain reported rather than suppressed.
- [x] At runtime startup, alongside detached artifact cleanup, asynchronously archive normal project `.jsonl` transcripts whose filesystem mtime is strictly more than 30 days old.
- [x] Reuse `.jsonl.zst` and existing control-DB path relocation/archive state. Keep automatic archives hidden from normal listing and resume by ID/name, just like manual archives; explicit paths and Archived picker restore them.
- [x] Skip recent files, the starting runtime's transcript, `/proc`-referenced files, and transcripts owned by live session listeners/health records or nonterminal agents (including separate child transcript paths).
- [x] Stream compression and verify decompressed bytes against the original before atomically publishing without overwriting an existing archive. Recheck source identity/mtime/size and live ownership before removing the plain file.
- [x] Preserve permissions and archive listing metadata; restore identical content and session identity on explicit resume.
- [x] Read compressed headers, full entries, fork sources, viewer/history data, goal references, HTML exports, and all seven repository transcript/statistics scripts without unarchiving them. Old literal `.jsonl` references resolve to an existing `.jsonl.zst` when no plain file exists.
- [x] Explicit archived attach restores writable storage before opening the session.
- [x] Core header/entry readers handle compressed transcripts exceeding Node's maximum string length, parsing one line at a time rather than decoding the entire file as one string.
- [x] Opening compacted current-version plain or archived sessions retains only the plain loader's active slice, header, and existing manager metadata; scanning summarized ancestors must not retain their payloads. Archived viewer, HTML/terminal export, history-search input, and fork outputs match the same plain transcript. Explicit full-entry reads remain full-entry reads.
- [x] A fresh child opening a generated 500+ MiB compacted transcript without a preceding cwd marker stays below 256 MiB peak RSS for both storage formats (`session-load-memory.test.ts`).
- [x] Interrupted archival converges: when both `.jsonl` and `.jsonl.zst` exist, the next pass completes archival if the archive decodes byte-identical, otherwise keeps the appended plain file canonical and removes the stale archive. Restoring through either path in either state returns writable plain storage with control-DB metadata pointing to it (`idle-session-archive.test.ts`).

### First-party `/archive` command

- [x] Register `/archive` in the session-archive extension (`session-archive-extension.test.ts`).
- [x] Reject arguments with usage guidance; the command accepts no arguments.
- [x] Archive only the current persisted session, then quit Pi; the archive runs at quit teardown and only when teardown is a quit (`session-archive-extension.test.ts`).
- [x] Report when the current session is not persisted.
- [x] Report when no control database is available.
- [x] Report an archive failure at quit on stderr.

### First-party `/delete` command

- [x] Accept no arguments; reject arguments with `/delete` usage guidance.
- [x] Refuse with a warning, without confirming or quitting, while any child agent session of the current runtime is still running, because an aborted child can still write its transcript (`session-archive-extension.test.ts`).
- [x] Ask for confirmation; declining keeps the session and Pi running (`session-archive-extension.test.ts`).
- [x] On confirmation, quit Pi and at quit teardown delete the current session and every child agent session recorded under it (recursively), removing their control-DB metadata (`session-archive-extension.test.ts`).
- [x] Move files to the trash when the `trash` CLI succeeds, otherwise delete permanently; report failures on stderr.

### Resume picker delete

- [x] Ctrl+D, then confirm, deletes the selected session and every child agent session recorded under it with the same removal as `/delete` (`session-selector-path-delete.test.ts`).

### Deletion responsiveness and completion

- [x] Session-tree deletion must not freeze the UI through synchronous trash processes (`session-delete.test.ts`).
- [x] The picker and `/delete` quit teardown must await deletion completion, preserving unrelated sessions and metadata for files that could not be deleted (`session-delete.test.ts`, `session-selector-path-delete.test.ts`, `session-archive-extension.test.ts`).

### First-party `/unarchive` command

- [x] Accept no arguments; reject arguments with `/unarchive` usage guidance.
- [x] Clear archive metadata only for the current persisted session through the existing control-DB API (`session-archive-extension.test.ts`).
- [x] Keep the current session, transcript, and manager unchanged; do not open a picker, resolve IDs, or switch sessions.
- [x] Report already-unarchived state as an informative no-op without writing metadata.
- [x] Report missing session persistence or control database.

### Administrative CLI

- [x] Provide `pi sessions archive [--older-than <days>]`, defaulting to 5 days, and report the archived count (`sessions-command.test.ts`).
- [x] Archive only non-subagent sessions older than the supplied cutoff (`session-control-db.test.ts`).
- [x] Provide `pi sessions compress-archived [--dry-run]` to migrate existing metadata-archived plain JSONL files while reporting results and excluding live resident transcripts.

## How it works

- See [`docs/wiki/systems/session-archive.md`](../wiki/systems/session-archive.md) for the current behavior and boundaries.

## Implementation inventory

- `packages/coding-agent/extensions/session-archive/src/index.ts` — registers argument-free `/archive`, `/delete`, and `/unarchive` commands targeting only the current persisted session.
- `packages/coding-agent/src/core/session-delete.ts` — shared session and child-agent-session deletion used by `/delete` and the picker.
- `packages/coding-agent/src/core/session-control-db.ts` — archive metadata schema, migration, listing, and archive APIs.
- `packages/coding-agent/src/core/session-manager.ts` — active, archived, and read-only session loaders.
- `packages/coding-agent/src/core/idle-session-archive.ts` — age/ownership screening, streamed byte-verified automatic archival.
- `packages/coding-agent/src/core/session-transcript.ts` — shared archived path resolution and text/stream readers.
- `scripts/{session-transcripts,cost,stats,tool-stats}.ts`, `scripts/{session-context-stats,read-tool-stats,edit-tool-stats}.mjs` — read both plain and compressed transcripts.
- `packages/coding-agent/src/cli/sessions-command.ts` — age-based administrative archive command.
- `packages/coding-agent/src/cli/session-picker.ts` — startup picker archive loader.
- `packages/coding-agent/src/modes/interactive/components/session-selector.ts` — Archived picker scope and Ctrl+A archive action.
- `packages/coding-agent/src/main.ts` — default first-party extension registration and picker wiring.

## Tests asserting this spec

- `packages/coding-agent/test/idle-session-archive.test.ts` — age boundary, byte identity, metadata, permissions, real-process file references, active DB agents/listeners, no-clobber, and cross-process startup races at source inspection and archive publication.
- `packages/coding-agent/test/fixtures/idle-session-archive/race-worker.ts` — independent Pi worker fixture for those races; assertions cover the winning archive's bytes and control-DB metadata.
- `packages/coding-agent/test/archived-transcript-readers.test.ts` — read-only history, headers, entries, fork, goal references, export, and resumed search parity.
- `packages/coding-agent/test/session-manager/session-load-parity.test.ts` — baseline plain-loader state, zero/one/two compactions, cwd ancestors, abandoned branches, viewer state, HTML/terminal exports, search, forks, SQLite settings, and goal-reference parity.
- `packages/coding-agent/test/session-manager/session-load-memory.test.ts` — fresh-process peak RSS on a generated 500+ MiB transcript in both formats.
- `packages/coding-agent/test/session-manager/session-transcript-spool.test.ts` — byte-exact decoding, temporary-file cleanup, and corrupt-archive errors.
- `packages/coding-agent/test/archived-transcript-scripts.test.ts` — all seven scripts read real compressed fixtures in child CLI processes.
- `packages/coding-agent/test/goal-extension.test.ts` — archived legacy-parent goal inheritance.
- `packages/coding-agent/test/multi-agent-extension.test.ts` — explicit-path archived attachment preserves transcript identity.

- `packages/coding-agent/test/session-archive-extension.test.ts`
- `packages/coding-agent/test/session-delete.test.ts`
- `packages/coding-agent/test/session-control-db-batch-delete.test.ts`
- `packages/coding-agent/test/session-control-db.test.ts`
- `packages/coding-agent/test/sessions-command.test.ts`
- `packages/coding-agent/test/session-selector-path-delete.test.ts`
- `packages/coding-agent/test/session-picker-selection.test.ts` — excludes resident transcripts from Current Folder, All, and Archived scopes.
- `packages/coding-agent/test/suite/resident-session-recovery.test.ts` — preserves a live Supervisor transcript while pruning stale resident history.
- `packages/coding-agent/test/architect-service.test.ts` — preserves a live Architect transcript while pruning stale resident history.

## Known gaps (current cycle)

- [x] Host `aso`: `claude-memory` (628b22d) indexes Pi `.jsonl.zst` transcripts with unchanged session identity; `agent-history` searches through `claude-memory`.
- [ ] History search in a resumed session does not find entries before its latest compaction, for plain and archived transcripts alike (reopen loads the active slice).

- [x] Persist dedicated Supervisor and Architect transcripts with `archived_at` set while retaining their live plain `.jsonl` storage.

## Out of scope

- Moving session JSONL files into a separate filesystem directory.
- A second gzip compression format; automatic archival deliberately reuses existing zstd storage.
- Permanent deletion or trash cleanup.
- Archiving sessions by age through `/archive`; use `pi sessions archive` for age-based administrative archival.
