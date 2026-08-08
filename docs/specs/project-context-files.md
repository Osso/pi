# Project Context Files

Module boundary: core resource-loader feature, not a first-party extension module.

Pi assembles model-facing project context from instruction files and durable project memory. `packages/coding-agent/src/core/resource-loader.ts` loads instruction candidates from the global agent directory and cwd ancestors, using AGENTS-family files whenever one or more candidates load successfully in a directory and CLAUDE-family files only as that directory's fallback; it then loads `docs/local/memory.md` from each cwd ancestor only. The contract lives here; how loading and deduplication work belongs in [docs/wiki/systems/project-context-files.md](../wiki/systems/project-context-files.md).

## What it must do

### Instruction-file discovery

- [x] In the global agent directory and each cwd ancestor, Pi loads every AGENTS-family candidate that reads successfully when at least one AGENTS-family candidate loads successfully in that directory.
- [x] When no AGENTS-family candidate loads successfully in a directory, Pi loads every CLAUDE-family candidate that reads successfully there.
- [x] AGENTS-family selection and CLAUDE-family fallback are evaluated independently for each searched directory.

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

- `packages/coding-agent/test/resource-loader.test.ts` — asserts cwd-ancestor discovery, same-directory ordering, direct and symlinked global-agent exclusion, instruction-symlink preservation, and `noContextFiles` suppression.

## Known gaps (current cycle)

- None.

## Out of scope

- Loading `docs/local/memory.md` from the global agent directory.
- Loading arbitrary files under `docs/local/`.
- Project trust gating for context files; project context remains available before trust resolution unless context loading is disabled.
