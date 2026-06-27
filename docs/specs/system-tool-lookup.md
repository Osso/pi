# System Tool Lookup

Pi uses external command-line tools such as `fd` and `rg` when they are
installed on the user's system. Pi must not auto-download these tools at runtime.

## What it must do

- [x] Resolve `fd` and `rg` from system `PATH` only.
- [x] Support platform aliases such as `fdfind` for `fd`.
- [x] Return unavailable when the tool is missing instead of downloading a
  release asset.
- [x] Show installation guidance instead of performing network bootstrap.

## Implementation inventory

- `packages/coding-agent/src/utils/tools-manager.ts` — system-only lookup for
  optional external tools.
- `packages/coding-agent/src/core/tools/find.ts` — reports missing `fd`.
- `packages/coding-agent/src/core/tools/grep.ts` — reports missing `rg`.

## Tests asserting this spec

- `packages/coding-agent/test/tools-manager.test.ts`
