Module boundary: first-party extension module (`packages/coding-agent/extensions/session-archive/`) plus core session-control-DB archive state and resume-picker behavior.

Sessions archived through `/archive`, the resume picker, or `pi sessions archive` are stored as `.jsonl.zst` files and tracked in control-DB metadata. Resuming one restores plain `.jsonl` storage and active metadata. Each resident role has exactly one metadata-archived Supervisor or Architect transcript, which remains plain `.jsonl` because its live runtime appends to it; opening a role reuses its live transcript when present, otherwise reuses the latest resident transcript, and prunes only inactive stale transcripts and metadata. Resident histories are excluded from every resume-picker scope, including Archived. Non-resident sessions abandoned with no messages are removed at runtime teardown or replacement; startup also removes dead, fileless zero-message rows left by interrupted processes. The first-party `/archive` command accepts no arguments and archives only the current persisted session. The resume picker archives the selected session with Ctrl+A. The separate `pi sessions archive` CLI command remains an age-based administrative bulk operation. `pi sessions compress-archived [--dry-run]` is a one-time migration for older metadata-archived plain JSONL transcripts; it excludes live resident Supervisor and Architect transcripts and reports migrated, skipped, and failed sessions. `pi sessions truncate-tool-output` is a separate maintenance command that may rewrite session JSONL files; see [`session-tool-output.md`](session-tool-output.md).

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

### First-party `/archive` command

- [x] Register `/archive` in the session-archive extension (`session-archive-extension.test.ts`).
- [x] Reject arguments with usage guidance; the command accepts no arguments.
- [x] Archive only the current persisted session (`session-archive-extension.test.ts`).
- [x] Report when the current session is not persisted.
- [x] Report when no control database is available.
- [x] Notify after archiving the current session.

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

- `packages/coding-agent/extensions/session-archive/src/index.ts` — registers argument-free `/archive` and `/unarchive` commands targeting only the current persisted session.
- `packages/coding-agent/src/core/session-control-db.ts` — archive metadata schema, migration, listing, and archive APIs.
- `packages/coding-agent/src/core/session-manager.ts` — active and archived session loaders.
- `packages/coding-agent/src/cli/sessions-command.ts` — age-based administrative archive command.
- `packages/coding-agent/src/cli/session-picker.ts` — startup picker archive loader.
- `packages/coding-agent/src/modes/interactive/components/session-selector.ts` — Archived picker scope and Ctrl+A archive action.
- `packages/coding-agent/src/main.ts` — default first-party extension registration and picker wiring.

## Tests asserting this spec

- `packages/coding-agent/test/session-archive-extension.test.ts`
- `packages/coding-agent/test/session-control-db.test.ts`
- `packages/coding-agent/test/sessions-command.test.ts`
- `packages/coding-agent/test/session-selector-path-delete.test.ts`
- `packages/coding-agent/test/session-picker-selection.test.ts` — excludes resident transcripts from Current Folder, All, and Archived scopes.
- `packages/coding-agent/test/suite/resident-session-recovery.test.ts` — preserves a live Supervisor transcript while pruning stale resident history.
- `packages/coding-agent/test/architect-service.test.ts` — preserves a live Architect transcript while pruning stale resident history.

## Known gaps (current cycle)

- [x] Persist dedicated Supervisor and Architect transcripts with `archived_at` set while retaining their live plain `.jsonl` storage.

## Out of scope

- Moving session JSONL files into a separate filesystem directory.
- Automatic scheduled archival; archive actions are explicit.
- Permanent deletion or trash cleanup.
- Archiving sessions by age through `/archive`; use `pi sessions archive` for age-based administrative archival.
