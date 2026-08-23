# Session autonaming

Session autonaming is a default first-party extension that gives persisted never-named main sessions a short 2–4 word title after a real-user turn. This document defines the behavior contract; implementation details belong in [`docs/wiki/systems/session-autoname.md`](../wiki/systems/session-autoname.md).

## What it must do

### Trigger and title

- [x] In interactive TUI and RPC modes, after the first agent turn that follows a real user message, asynchronously ask the active model for a short 2–4 word session title summarizing the conversation so far. Empty, aborted, and failed responses still qualify.
- [x] Persist the generated title through the existing session-naming behavior in `session_metadata.name`; no JSONL name entry is written.
- [x] Do not delay completion of the originating user exchange while generating the title.

### Eligibility and exclusions

- [x] Trigger only for persisted never-named main sessions: `session_metadata.name IS NULL`.
- [x] Do not trigger in print or JSON modes, ephemeral sessions, or child-agent sessions.
- [x] Do not trigger for already-named sessions or sessions explicitly cleared with `session_metadata.name = ''`.
- [x] An `agent_end` caused only by extension activity cannot trigger from an older real-user message elsewhere on the branch.
- [x] Do not trigger from turns without a real user message (extension-only activity).
- [x] Do not trigger from intermediate cwd-relocation events.

### Manual control and failure

- [x] A manual `/name` or `/unname` during title generation wins over the generated title; `/unname` stores `session_metadata.name = ''`, remains cleared after restart, and blocks later autonaming.
- [x] A title-generation failure leaves the session unnamed.

## How it works

- [`docs/wiki/systems/session-autoname.md`](../wiki/systems/session-autoname.md) — implementation description (stub).

## Implementation inventory

- `packages/coding-agent/extensions/session-autoname/src/index.ts` — first-party session-autonaming extension.
- `packages/coding-agent/src/main.ts` — default first-party extension registration.

## Tests asserting this spec

- `packages/coding-agent/test/session-autoname-extension.test.ts`

## Known gaps (current cycle)

None.

## Out of scope

- Automatic naming in print or JSON modes.
- Naming ephemeral, child-agent, or already-named sessions.
- Renaming sessions as the conversation evolves.
- Replacing manual session naming or defining a title policy beyond the 2–4 word contract.
