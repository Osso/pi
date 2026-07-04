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
- [x] Session-listing metadata is maintained incrementally: appended entries fold into a
      per-session accumulator (rebuilt only after wholesale entry replacement such as resume,
      branch, or new session), and entries that cannot change session metadata (custom entries,
      labels, compaction records) do not trigger a metadata write at all.
- [x] Store multi-agent state as per-entity rows keyed by session path
      (`multi_agent_agents`, `multi_agent_artifacts`, `multi_agent_mailbox_messages`,
      `multi_agent_counters`): one row upsert per mutation, restore selects the session's rows.
- [x] Runtime mailbox transport rows do not copy message bodies from persisted stores: they
      carry a store reference (`store_session_path`, `store_message_id`) and reads resolve
      body/artifact payloads from `multi_agent_mailbox_messages`. Only unpersisted (in-memory)
      senders copy the body into the transport row.
- [x] Store prompt history in the control DB so concurrent Pi sessions append
  without overwriting each other's prompt history entries.
- [x] Migrate legacy JSON prompt history into the control DB when DB prompt
  history is empty.
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
  schema, incoming-message claim/complete API, last-message API, prompt-history
  API, and session metadata API.
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
- `packages/coding-agent/test/custom-editor-history.test.ts`
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
