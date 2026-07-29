# CLI session lookup

Module boundary: core CLI session startup (`packages/coding-agent/src/main.ts`).

The `--session <id>` option resolves saved session files from the current project and,
when needed, the global session directory. A session belongs to the current project when its
stored cwd matches the current cwd or both cwds resolve to worktrees sharing one Git common
directory. Different Git projects require fork confirmation; accepting that confirmation must
complete the fork and continue startup without hanging. Implementation
details live in [`docs/wiki/systems/session-cli-lookup.md`](../wiki/systems/session-cli-lookup.md).

## What it must do

### Session resolution

- [x] Resolve an exact or prefix session ID from the current project's sessions before searching global sessions.
- [x] Search globally when the requested session is not found in the current project.
- [x] Open a globally found session directly when its stored cwd matches the current cwd or a Git worktree sharing the same common directory; do not report a different project, prompt to fork, or create a fork.
- [x] Report sessions from different Git projects as different projects, retain the fork confirmation, and continue startup after an affirmative response without hanging.

### Missing stored cwd

- [x] When a selected session's stored cwd no longer exists, normalize the supplied current cwd to its nearest existing parent before presenting or using it as the recovery fallback (`packages/coding-agent/test/session-cwd.test.ts`, `packages/coding-agent/test/suite/regressions/missing-session-cwd-restart.test.ts`).

## How it works

- [`docs/wiki/systems/session-cli-lookup.md`](../wiki/systems/session-cli-lookup.md) describes CLI session resolution and project matching.

## Implementation inventory

- `packages/coding-agent/src/main.ts` — resolves `--session` targets and opens or forks the selected session.
- `packages/coding-agent/src/core/session-cwd.ts` — normalizes the recovery cwd when a selected session's stored cwd is missing.

## Tests asserting this spec

- `packages/coding-agent/test/session-project-lookup.test.ts` — verifies same-repository worktree sessions open directly, while different-project sessions retain fork confirmation and complete after `y` without hanging.
- `packages/coding-agent/test/session-cwd.test.ts` — verifies missing-session cwd recovery uses the nearest existing parent.
- `packages/coding-agent/test/suite/regressions/missing-session-cwd-restart.test.ts` — verifies a real self-restarted process whose cwd was deleted offers that existing parent in the interactive recovery prompt.

## Known gaps (current cycle)

None.

## Out of scope

- Direct session-file paths and external session aliases.
- The explicit `--fork` command path.
- Resume-picker search and in-session `resume_session` behavior.
