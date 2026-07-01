# Loop tool

Module boundary: first-party extension module.

The loop tool lets the agent or user schedule a recurring prompt that is injected back into the current Pi session at a fixed interval. Source lives in `packages/coding-agent/extensions/loop/src/index.ts`. How the extension runtime delivers injected messages belongs in [`docs/wiki/systems/loop-tool.md`](../wiki/systems/loop-tool.md).

## What it must do

### Tool API

- [x] Register a `loop` tool that supports `start`, `stop`, and `status` actions.
- [x] Require approval before the model can use the `loop` tool.
- [x] For `start`, require a prompt and an interval of at least one second.
- [x] For `start`, replace any existing active loop with the new loop.
- [x] For `stop`, clear the active loop and report whether a loop was stopped.
- [ ] For `status`, report whether a loop is active and include the active interval and prompt when present.

### Slash command API

- [x] Register a `/loop` slash command.
- [x] Support `/loop <interval> <prompt>` to start a recurring prompt.
- [x] Support `/loop stop`, `/loop off`, and `/loop clear` to stop the active loop.
- [ ] Support `/loop` and `/loop status` to inspect the active loop.
- [x] Accept interval units `ms`, `s`, `m`, and `h`, with seconds as the default unit.
- [x] Reject intervals below one second.

### Runtime behavior

- [x] Inject the configured prompt only after the first full interval elapses, not immediately on start.
- [x] Inject recurring prompts as follow-up user messages in the current session.
- [x] Stop injecting prompts after the active loop is stopped.
- [x] Clear the active timer when the session shuts down.
- [ ] Expose only one active loop per session.
- [ ] Keep loop state session-local; do not persist loops across process restarts or restored sessions.

## How it works

- Runtime design: [`docs/wiki/systems/loop-tool.md`](../wiki/systems/loop-tool.md) (stub).
- Extension API and injected messages: [`docs/specs/prompt-context-hooks.md`](prompt-context-hooks.md).
- First-party extension loading: [`docs/specs/runtime-inventory.md`](runtime-inventory.md).

## Implementation inventory

- `packages/coding-agent/extensions/loop/src/index.ts` — first-party loop extension; registers the `loop` tool, `/loop` command, timer lifecycle, and injected follow-up prompts.
- `packages/coding-agent/src/main.ts` — loads the first-party loop extension into the coding-agent runtime.
- `packages/coding-agent/src/core/extensions/types.ts` — defines the extension tool, command, event, and `sendUserMessage` API surface used by the loop extension.
- `packages/coding-agent/src/core/extensions/runner.ts` — binds extension `sendUserMessage` calls to the active agent session runtime.
- `packages/coding-agent/src/core/agent-session.ts` — delivers extension-injected user messages as follow-up or steering messages.

## Tests asserting this spec

- `packages/coding-agent/test/loop-extension.test.ts` — asserts registration, approval requirement, slash-command interval injection, tool start/stop behavior, stopped loops, and session shutdown cleanup.

## Known gaps (current cycle)

- [ ] Add explicit test coverage for `status` tool details.
- [ ] Add explicit test coverage for `/loop` and `/loop status` notifications.
- [ ] Add explicit test coverage that starting a new loop replaces the prior loop.
- [ ] Add explicit test coverage that loop state is not persisted across extension/controller instances.

## Out of scope

- Persistent loops across process restarts or restored sessions; recurrence is intentionally current-session only.
- Multiple named loops per session; the extension exposes one active loop at a time.
- Calendar, cron, or wall-clock scheduling; intervals are fixed delays only.
