# Self Restart

Self restart lets an agent ask Pi to tear down the current in-process session
runtime or, in interactive mode, exit and spawn a fresh Pi process from the same
session file with a restart notice added to the resumed conversation. How the
runtime replacement works belongs in `docs/wiki/systems/self-restart.md`.

## What it must do

### Extension API

- [x] Expose a command-context `restart()` action to extensions.
- [x] Emit `session_shutdown` and `session_start` lifecycle events with reason
  `restart` while preserving the same session file.
- [x] Let interactive mode spawn a fresh Pi process directly with the same argv
  and an environment restart request that resumes the current session.
- [x] Do not provide wrapper request-file or restart-exit-code fallback paths;
  process self restart always uses direct child process spawn.
- [x] Let an external supervisor restart interactive mode by sending `SIGHUP`, using the same
  persisted-session process handoff as `restart_self`.

### First-party Tool

- [x] Register a `/restart` slash command from the first-party extension.
- [x] Register a `restart_self` tool from a first-party extension.
- [x] Add a user-visible restart notice to the same session when the tool runs.

## How it works

- `docs/wiki/systems/self-restart.md`
- `docs/specs/session-lifecycle-hooks.md`

## Implementation inventory

- `packages/coding-agent/extensions/self-restart/src/index.ts` — first-party
  restart slash command and tool registration.
- `packages/coding-agent/src/core/agent-session-runtime.ts` — same-session
  runtime replacement.
- `packages/coding-agent/src/core/agent-session.ts` — command-context restart
  binding.
- `packages/coding-agent/src/core/extensions/types.ts` — extension API and
  lifecycle reason types.
- `packages/coding-agent/src/core/self-restart.ts` — process restart request
  environment handling and child process spawn.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` —
  interactive terminal shutdown and process handoff.

## Tests asserting this spec

- `packages/coding-agent/test/self-restart.test.ts`
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts`
- `packages/coding-agent/test/suite/regressions/2860-replaced-session-context.test.ts`
- `packages/coding-agent/test/self-restart-extension.test.ts`
- `packages/coding-agent/test/suite/regressions/sighup-restart-harness.test.ts`

## Known gaps (current cycle)

- [ ] Print and RPC modes use in-process runtime restart instead of spawning a
  new process because they do not own an interactive terminal.

## Out of scope

- Restarting external supervisors, tmux sessions, or terminal emulators.
