Module boundary: first-party extension module (`packages/coding-agent/extensions/session-archive/`) plus core session-control-DB archive state and resume-picker behavior.

Pi persists archive state for session transcripts without moving or deleting their JSONL files. The first-party `/archive` command accepts no arguments and archives only the current persisted session. The resume picker archives the selected session with Ctrl+A. The separate `pi sessions archive` CLI command remains an age-based administrative bulk operation.

## What it must do

### Archive state and picker

- [x] Persist an archive timestamp in control-DB session metadata.
- [x] Archive and unarchive a session without changing its transcript path or contents (`session-control-db.test.ts`).
- [x] Hide archived sessions from normal session metadata listings used by Current Folder and All resume scopes.
- [x] Expose archived sessions through a dedicated Archived resume-picker scope (`session-selector-path-delete.test.ts`).
- [x] Archive the selected picker session when Ctrl+A is pressed (`session-selector-path-delete.test.ts`).

### First-party `/archive` command

- [x] Register `/archive` in the session-archive extension (`session-archive-extension.test.ts`).
- [x] Reject arguments with usage guidance; the command accepts no arguments.
- [x] Archive only the current persisted session (`session-archive-extension.test.ts`).
- [x] Report when the current session is not persisted.
- [x] Report when no control database is available.
- [x] Notify after archiving the current session.

### Administrative CLI

- [x] Provide `pi sessions archive [--older-than <days>]`, defaulting to 5 days, and report the archived count (`sessions-command.test.ts`).
- [x] Archive only non-subagent sessions older than the supplied cutoff (`session-control-db.test.ts`).

## How it works

- See [`docs/wiki/systems/session-archive.md`](../wiki/systems/session-archive.md) for the current behavior and boundaries.

## Implementation inventory

- `packages/coding-agent/extensions/session-archive/src/index.ts` — registers `/archive`, validates that it has no arguments, and archives the current persisted session.
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

## Out of scope

- Moving session JSONL files into a separate filesystem directory.
- Automatic scheduled archival; archive actions are explicit.
- Permanent deletion or trash cleanup.
- Archiving sessions by age through `/archive`; use `pi sessions archive` for age-based administrative archival.
