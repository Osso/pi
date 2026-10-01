# CLI session lookup

Module boundary: core CLI session startup (`packages/coding-agent/src/main.ts`).

The `--session <id>` option resolves saved session files from the current project and,
when needed, the global session directory. A found session always opens in its own stored cwd,
whichever project the CLI was started from. Implementation
details live in [`docs/wiki/systems/session-cli-lookup.md`](../wiki/systems/session-cli-lookup.md).

## What it must do

### Session resolution

- [x] Resolve an exact or prefix session ID from the current project's sessions before searching global sessions.
- [x] Search globally when the requested session is not found in the current project.
- [x] Open a globally found session directly in its stored cwd, including sessions from a different Git project; do not report a different project, prompt to fork, or create a fork.

### Missing stored cwd

- [x] When a selected session's stored cwd no longer exists, normalize the supplied current cwd to its nearest existing parent before presenting or using it as the recovery fallback (`packages/coding-agent/test/session-cwd.test.ts`, `packages/coding-agent/test/suite/regressions/missing-session-cwd-restart.test.ts`).

## How it works

- [`docs/wiki/systems/session-cli-lookup.md`](../wiki/systems/session-cli-lookup.md) describes CLI session resolution and project matching.

## Implementation inventory

- `packages/coding-agent/src/main.ts` — resolves `--session` targets and opens the selected session.
- `packages/coding-agent/src/core/session-cwd.ts` — normalizes the recovery cwd when a selected session's stored cwd is missing.

## Tests asserting this spec

- `packages/coding-agent/test/session-project-lookup.test.ts` — verifies same-repository worktree and different-project sessions open directly without a fork prompt, and that a different-project session keeps its recorded cwd.
- `packages/coding-agent/test/session-cwd.test.ts` — verifies missing-session cwd recovery uses the nearest existing parent.
- `packages/coding-agent/test/suite/regressions/missing-session-cwd-restart.test.ts` — verifies a real self-restarted process whose cwd was deleted offers that existing parent in the interactive recovery prompt.

## Known gaps (current cycle)

None.

## Out of scope

- Direct session-file paths and external session aliases.
- The explicit `--fork` command path.
- Resume-picker search and in-session `resume_session` behavior.
