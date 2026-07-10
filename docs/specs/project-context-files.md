# Project Context Files

Module boundary: core resource-loader feature, not a first-party extension module.

Pi assembles model-facing project context from instruction files and durable project memory. `packages/coding-agent/src/core/resource-loader.ts` loads AGENTS/CLAUDE candidates from the global agent directory and cwd ancestors, then loads `docs/local/memory.md` from each cwd ancestor only. The contract lives here; how loading and deduplication work belongs in [docs/wiki/systems/project-context-files.md](../wiki/systems/project-context-files.md).

## What it must do

### Project-memory discovery

- [x] When `<cwd>/docs/local/memory.md` exists, Pi includes it as a project context file (`resource-loader.test.ts`, "should load docs/local/memory.md as project context").
- [ ] In every cwd ancestor, Pi considers `docs/local/memory.md` after that directory's AGENTS/CLAUDE candidate sequence.
- [ ] Pi reads project memory from cwd ancestors only and never from `<agentDir>/docs/local/memory.md`.

### Controls

- [ ] `noContextFiles` disables project-memory discovery together with AGENTS/CLAUDE context-file discovery.

## How it works

- [docs/wiki/systems/project-context-files.md](../wiki/systems/project-context-files.md) (stub — not yet written).

## Implementation inventory

- `packages/coding-agent/src/core/resource-loader.ts` — declares context-file candidates, loads global instruction files and cwd-ancestor project context, and bypasses all automatic context discovery when `noContextFiles` is set.

## Tests asserting this spec

- `packages/coding-agent/test/resource-loader.test.ts` — discovers `<cwd>/docs/local/memory.md` as project context.

## Known gaps (current cycle)

- [ ] Add a regression that asserts ordering after same-directory AGENTS/CLAUDE candidates.
- [ ] Add a regression that asserts `<agentDir>/docs/local/memory.md` is not loaded.
- [ ] Add a regression that asserts `noContextFiles` suppresses `docs/local/memory.md`.

## Out of scope

- Loading `docs/local/memory.md` from the global agent directory.
- Loading arbitrary files under `docs/local/`.
- Project trust gating for context files; project context remains available before trust resolution unless context loading is disabled.
