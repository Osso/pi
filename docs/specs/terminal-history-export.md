# Read-only Terminal History Export

Pi exports saved active-branch conversation history as terminal-safe ANSI text through `packages/coding-agent/src/core/export-terminal.ts` and the one-shot CLI. See [terminal history export](../../packages/coding-agent/docs/terminal-history-export.md) for usage and implementation behavior.

## What it must do

### Saved history and rendering

- [x] Include saved exchanges before and after compaction in native terminal scrollback, excluding discarded siblings, hidden custom messages, and non-message state metadata while retaining visible custom messages and compaction summaries.
- [x] Reuse collapsed tool presentation; preserve text while excluding image protocols and all terminal controls except renderer-generated SGR styles.
- [x] Leave source bytes and modification time unchanged, create no adjacent files, and make no fetch calls during core export.
- [x] Migrate legacy history only in memory.
- [x] Reject invalid widths, missing files, malformed history, and cyclic active ancestry explicitly.

### CLI

- [x] Require `--export-terminal <file-or-id>` and `--export-columns <positive-safe-integer>` together; allow only `--session-dir` and `--offline` alongside them.
- [x] Resolve saved files and session IDs in an explicit session directory without provider calls, extension execution, or settings/session writes.
- [x] Default-directory ID lookup does not create directories or a control database, or update metadata.
- [x] Flush the complete LF-terminated ANSI output to stdout before exit, including output larger than a pipe buffer; send diagnostics to stderr.
- [x] Exit `4` for an unresolved session ID and `1` for other failures, including missing files, invalid arguments, and unsupported external aliases.

## How it works

- [CLI, rendering, source API, and transport boundary](../../packages/coding-agent/docs/terminal-history-export.md)
- [Normal compaction-aware loading](../../packages/coding-agent/docs/session-format.md#current-version-loading)

## Implementation inventory

- `packages/coding-agent/src/core/export-terminal.ts` — collapsed component rendering and SGR-only output sanitization.
- `packages/coding-agent/src/core/session-manager.ts` — read-only full saved parent-chain loader, separate from normal loading.
- `packages/coding-agent/src/cli/args.ts` — paired option parsing and export-mode validation.
- `packages/coding-agent/src/main.ts` — early read-only lookup, theme initialization, stdout flush, and exit handling.

## Tests asserting this spec

- `packages/coding-agent/test/suite/regressions/terminal-history-export.test.ts` — four passing core cases, including headless native terminal-buffer assertions.
- `packages/coding-agent/test/args.test.ts` — 109 passing argument cases.
- `packages/coding-agent/test/suite/export-terminal-cli.test.ts` — ten passing cases, including >150 KB output with 1,200 history markers and read-only default-directory lookup.

## Known gaps (current cycle)

- [ ] Installed-binary and consuming-client scrollback integration verification remains pending.

## Out of scope

- Live renderer, interactive history lifecycle, and model-context changes: this is a separate read-only export.
- Local scrollback seeding, SSH/Mosh attachment, and reconnect orchestration: owned by the consuming client.
- Expanded tool output, image rendering, extension execution, HTML export changes, or regenerating unavailable history.
