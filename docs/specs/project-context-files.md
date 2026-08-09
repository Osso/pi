# Project Context Files

Module boundary: core resource-loader feature, not a first-party extension module.

Pi assembles model-facing project context from instruction files and durable project memory. `packages/coding-agent/src/core/resource-loader.ts` scans the global agent directory and cwd ancestors for AGENTS-family candidates first; if any AGENTS-family candidate loads successfully anywhere in that hierarchy, CLAUDE-family paths are not accessed. Only when no AGENTS-family candidate loads successfully across the hierarchy does it load CLAUDE-family candidates. It then loads `docs/local/memory.md` from each cwd ancestor only. The contract lives here; how loading and deduplication work belongs in [docs/wiki/systems/project-context-files.md](../wiki/systems/project-context-files.md).

## What it must do

### Instruction-file discovery

- [x] Pi scans the global agent directory and every cwd ancestor for AGENTS-family candidates first, loading every candidate that reads successfully.
- [x] If any AGENTS-family candidate loads successfully anywhere in the hierarchy, Pi does not access CLAUDE-family paths anywhere in that search.
- [x] Only when no AGENTS-family candidate loads successfully across the hierarchy does Pi load every CLAUDE-family candidate that reads successfully.
- [x] Instruction-file output preserves global-first, root-to-cwd ordering; each cwd ancestor's `docs/local/memory.md` remains after that directory's selected instruction-file sequence.

### Project-memory discovery

- [x] In every cwd ancestor, Pi includes `docs/local/memory.md` after that directory's AGENTS/CLAUDE candidate sequence.
- [x] Pi reads project memory from cwd ancestors only and never from `<agentDir>/docs/local/memory.md`, including project-memory paths symlinked to that global file.
- [x] AGENTS/CLAUDE candidates remain loadable when symlinked to the global project-memory file; exclusion is based on the candidate path, not only its target.

### Controls

- [x] `noContextFiles` disables project-memory discovery together with AGENTS/CLAUDE context-file discovery.

## How it works

- [docs/wiki/systems/project-context-files.md](../wiki/systems/project-context-files.md) (stub — not yet written).

## Implementation inventory

- `packages/coding-agent/src/core/resource-loader.ts` — declares context-file candidates, loads global instruction files and cwd-ancestor project context, and bypasses all automatic context discovery when `noContextFiles` is set.

## Tests asserting this spec

- `packages/coding-agent/test/resource-loader.test.ts` — asserts hierarchy-wide AGENTS precedence and CLAUDE fallback, global/root-to-cwd ordering, project-memory placement and exclusion, instruction-symlink preservation, and `noContextFiles` suppression.

## Known gaps (current cycle)

- None.

## Out of scope

- Loading `docs/local/memory.md` from the global agent directory.
- Loading arbitrary files under `docs/local/`.
- Project trust gating for context files; project context remains available before trust resolution unless context loading is disabled.
