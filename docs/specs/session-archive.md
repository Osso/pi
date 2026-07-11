Module boundary: core session management and resume-picker behavior.

Pi persists an archive state for session transcripts without moving or deleting their JSONL files. Normal resume views exclude archived sessions, while the picker exposes an Archived scope and the CLI can archive old sessions globally.

## What it must do

- [x] Persist an archive timestamp in control-DB session metadata.
- [x] Archive and unarchive a session without changing its transcript path or contents (`session-control-db.test.ts`).
- [x] Archive only non-subagent sessions older than a supplied modified-time cutoff (`session-control-db.test.ts`).
- [x] Hide archived sessions from normal session metadata listings used by Current Folder and All resume scopes.
- [x] Expose archived sessions through a dedicated resume-picker scope.
- [x] Provide `pi sessions archive [--older-than <days>]`, defaulting to 5 days, and report the archived count (`sessions-command.test.ts`).

## How it works

- See `packages/coding-agent/src/core/session-control-db.ts` for durable archive metadata.
- See `packages/coding-agent/src/core/session-manager.ts` for active/archived listing separation.
- See `packages/coding-agent/src/modes/interactive/components/session-selector.ts` for picker scopes.

## Implementation inventory

- `packages/coding-agent/src/core/session-control-db.ts` — archive metadata schema, migration, listing, and bulk archive APIs.
- `packages/coding-agent/src/core/session-manager.ts` — active and archived session loaders.
- `packages/coding-agent/src/cli/sessions-command.ts` — bulk archive CLI command.
- `packages/coding-agent/src/cli/session-picker.ts` — startup picker archive loader.
- `packages/coding-agent/src/modes/interactive/components/session-selector.ts` — Archived picker scope.
- `packages/coding-agent/src/main.ts` — CLI command dispatch and startup picker wiring.

## Tests asserting this spec

- `packages/coding-agent/test/session-control-db.test.ts`
- `packages/coding-agent/test/sessions-command.test.ts`
- `packages/coding-agent/test/session-selector-path-delete.test.ts`

## Known gaps (current cycle)

- [x] Add a direct picker test proving archived rows are hidden from active scopes and visible in Archived (`session-selector-path-delete.test.ts`).

## Out of scope

- Moving session JSONL files into a separate filesystem directory.
- Automatic scheduled archival; the CLI command is explicit.
- Permanent deletion or trash cleanup.
