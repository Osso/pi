Module boundary: first-party extension module (`packages/coding-agent/extensions/session-archive/`) plus core session-review and control-DB archive state.

Pi persists archive state for session transcripts without moving or deleting their JSONL files. The first-party `/archive [days]` command reviews sessions modified within a recent window (default 5 days), archives clear completed sessions, skips incomplete or live sessions, and reports the result. The separate `pi sessions archive` CLI command remains an age-based administrative bulk operation.

## What it must do

### Archive state and picker

- [x] Persist an archive timestamp in control-DB session metadata.
- [x] Archive and unarchive a session without changing its transcript path or contents (`session-control-db.test.ts`).
- [x] Hide archived sessions from normal session metadata listings used by Current Folder and All resume scopes.
- [x] Expose archived sessions through a dedicated resume-picker scope (`session-selector-path-delete.test.ts`).

### First-party `/archive` review command

- [x] Register `/archive [days]` in the session-archive extension (`session-archive-extension.test.ts`).
- [ ] Assert that the session-archive extension is included in the default first-party extension set.
- [ ] Use a five-day default window when no argument is supplied.
- [ ] Accept a positive numeric day override and reject invalid arguments with usage guidance.
- [x] Archive a clear completed session while leaving an incomplete session unarchived (`session-archive-review.test.ts`).
- [ ] Review only sessions whose modified time is inside the selected window.
- [ ] Skip live sessions identified by active runtime listeners.
- [ ] Skip subagent sessions and already archived sessions.
- [x] Treat a conversation ending in a substantive assistant response as complete, and reject a trailing user response or explicit unfinished-work status (`session-archive-review.test.ts`).
- [ ] Report archived, incomplete, and live-skip counts through the command notification.
- [ ] Report a clear error when no control database is available.

### Administrative CLI

- [x] Provide `pi sessions archive [--older-than <days>]`, defaulting to 5 days, and report the archived count (`sessions-command.test.ts`).
- [x] Archive only non-subagent sessions older than the supplied cutoff (`session-control-db.test.ts`).

## How it works

- See [`docs/wiki/systems/session-archive.md`](../wiki/systems/session-archive.md) for the current behavior and boundaries.

## Implementation inventory

- `packages/coding-agent/extensions/session-archive/src/index.ts` — registers `/archive` and validates its day argument.
- `packages/coding-agent/src/core/session-archive.ts` — reviews recent sessions, classifies completion, skips live sessions, and archives clear completions.
- `packages/coding-agent/src/core/session-control-db.ts` — archive metadata schema, migration, listing, and archive APIs.
- `packages/coding-agent/src/core/session-manager.ts` — active and archived session loaders.
- `packages/coding-agent/src/cli/sessions-command.ts` — age-based administrative archive command.
- `packages/coding-agent/src/cli/session-picker.ts` — startup picker archive loader.
- `packages/coding-agent/src/modes/interactive/components/session-selector.ts` — Archived picker scope.
- `packages/coding-agent/src/main.ts` — default first-party extension registration and picker wiring.

## Tests asserting this spec

- `packages/coding-agent/test/session-archive-extension.test.ts`
- `packages/coding-agent/test/session-archive-review.test.ts`
- `packages/coding-agent/test/session-control-db.test.ts`
- `packages/coding-agent/test/sessions-command.test.ts`
- `packages/coding-agent/test/session-selector-path-delete.test.ts`

## Known gaps (current cycle)

- [ ] Add extension-level tests for `/archive` default and override parsing, notifications, and missing-control-DB handling.
- [ ] Add a default-extension inventory test for the session-archive extension.
- [ ] Add review tests for cutoff boundaries, live-session skipping, subagent exclusion, and already-archived sessions.

## Out of scope

- Moving session JSONL files into a separate filesystem directory.
- Automatic scheduled archival; both archive commands are explicit.
- Permanent deletion or trash cleanup.
- Archiving sessions solely because they are old through `/archive`; completion review is required there.
