Session control DB is the global control channel for the coding-agent runtime.
It lets an outside harness submit one incoming prompt and read the last assistant
reply without changing the JSONL transcript format. How it works lives in
[docs/wiki/systems/session-control-db.md](../wiki/systems/session-control-db.md).

## What it must do

- [x] Store the single control database at `control.sqlite` under the agent
  directory.
- [x] Store incoming harness messages outside the JSONL transcript.
- [x] Claim only the newest pending incoming message and supersede older pending
  messages.
- [x] Allow a claimed incoming message to be marked completed after it is
  submitted to the agent.
- [x] Store only the latest assistant message for external readers.
- [x] Provide `pi control send`, `pi control last`, and `pi control path` so
  harnesses use the CLI instead of writing SQLite directly.
- [x] Store named-session metadata in the control DB.
- [x] `/name <name>` names the current session and `/unname` removes that name.
- [x] Session restore lists show named sessions first, including threaded
  restore mode, and support clearing a selected session name from rename mode
  with an empty value.
- [x] On SIGHUP, restart the interactive process so startup can consume the
  control DB incoming message.

## How it works

- [docs/wiki/systems/session-control-db.md](../wiki/systems/session-control-db.md)

## Implementation inventory

- `packages/coding-agent/src/core/session-control-db.ts` — global SQLite path,
  schema, incoming-message claim/complete API, and last-message API.
- `packages/coding-agent/src/cli/control-command.ts` — `pi control` command
  parser and output.
- `packages/coding-agent/src/main.ts` — claims a pending incoming message before
  interactive startup and dispatches `pi control`.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — submits a
  claimed incoming message and records the latest assistant reply.
- `packages/coding-agent/src/core/self-restart.ts` — SIGHUP restart handoff keeps
  the resumed prompt list empty unless a caller explicitly provides a prompt.

## Tests asserting this spec

- `packages/coding-agent/test/session-control-db.test.ts`
- `packages/coding-agent/test/control-command.test.ts`
- `packages/coding-agent/test/session-selector-rename.test.ts`
- `packages/coding-agent/test/self-restart.test.ts`
- `packages/coding-agent/test/interactive-mode-startup-input.test.ts`

## Known gaps (current cycle)

- [x] Wire SIGHUP startup consumption and last-message recording into
  interactive mode.

## Out of scope

- JSONL transcript migration or JSONL control records.
- Full mailbox history beyond the newest pending incoming message and latest
  assistant reply.
