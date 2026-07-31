Module boundary: core session persistence plus the administrative `pi sessions truncate-tool-output` command.

Pi limits each persisted tool-result JSONL line to 1 MiB without changing the in-memory tool result. Existing session JSONL files can be rewritten through the explicit migration command; archive operations do not perform this maintenance.

## What it must do

### Persistence

- [x] Cap each persisted `toolResult` JSONL line at 1,048,576 UTF-8 bytes while leaving the runtime session entry unchanged (`session-tool-output.test.ts`).
- [x] Apply the cap to single-line output and multibyte UTF-8 without producing invalid replacement characters (`session-tool-output.test.ts`).
- [x] Preserve small tool results without allocating a replacement entry (`session-tool-output.test.ts`).
- [ ] Apply persistence-only truncation to normal writes, rewrites, forks, and relocation writes; the shared serializer is wired into these paths, but dedicated regression coverage is still missing.

### Historical migration

- [x] Provide `pi sessions truncate-tool-output` to scan session JSONL files below the agent directory and rewrite oversized tool results (`sessions-command.test.ts`, `session-tool-output.test.ts`).
- [x] Create a backup before each changed session file is replaced (`session-tool-output.test.ts`).
- [x] Replace each changed file atomically with the source mode preserved; stale files are skipped instead of overwritten (`session-tool-output.test.ts`).
- [x] Skip malformed JSONL and non-session JSONL without rewriting them (`session-tool-output.test.ts`).
- [x] Make a second migration pass idempotent after the first pass (`session-tool-output.test.ts`).

## How it works

- See [`docs/wiki/systems/session-tool-output.md`](../wiki/systems/session-tool-output.md) for current implementation boundaries and migration behavior.

## Implementation inventory

- `packages/coding-agent/src/core/session-tool-output.ts` — persistence cap, truncation marker, JSONL scan, backup, and atomic migration.
- `packages/coding-agent/src/core/session-manager.ts` — routes session writes, rewrites, forks, and relocations through capped serialization.
- `packages/coding-agent/src/cli/sessions-command.ts` — exposes the migration command and report.
- `packages/coding-agent/src/cli/args.ts` — lists the maintenance command in top-level CLI help.
- `packages/coding-agent/src/index.ts` — exports the cap and migration helpers.

## Tests asserting this spec

- `packages/coding-agent/test/session-tool-output.test.ts`
- `packages/coding-agent/test/sessions-command.test.ts`

## Known gaps (current cycle)

- [ ] Add dedicated regression coverage for rewrite, fork, and relocation paths.

## Out of scope

- Changing tool output shown in the TUI or sent to the model.
- Automatic migration at startup.
- Deleting backups or permanently deleting session files.
- Rewriting malformed or non-session JSONL files.
