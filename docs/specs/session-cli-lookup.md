# CLI session lookup

Module boundary: core CLI session startup (`packages/coding-agent/src/main.ts`).

The `--session <id>` option resolves saved session files from the current project and,
when needed, the global session directory. Matching the stored session cwd to the current
cwd means the session belongs to the current project and must open directly. Implementation
details live in [`docs/wiki/systems/session-cli-lookup.md`](../wiki/systems/session-cli-lookup.md).

## What it must do

### Session resolution

- [x] Resolve an exact or prefix session ID from the current project's sessions before searching global sessions.
- [x] Search globally when the requested session is not found in the current project.
- [x] Open a globally found session directly when its stored cwd resolves to the current cwd; do not report a different project, prompt to fork, or create a fork.

## How it works

- [`docs/wiki/systems/session-cli-lookup.md`](../wiki/systems/session-cli-lookup.md) describes CLI session resolution and project matching.

## Implementation inventory

- `packages/coding-agent/src/main.ts` — resolves `--session` targets and opens or forks the selected session.

## Tests asserting this spec

- `packages/coding-agent/test/session-project-lookup.test.ts` — verifies a globally located session with the current stored cwd opens directly without the different-project warning or fork prompt.

## Known gaps (current cycle)

None.

## Out of scope

- Direct session-file paths and external session aliases.
- The explicit `--fork` command path.
- Resume-picker search and in-session `resume_session` behavior.
