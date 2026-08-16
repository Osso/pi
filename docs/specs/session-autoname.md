# Session autonaming

Session autonaming is a default first-party extension that gives persisted unnamed main sessions a short title after the first completed substantive real-user exchange. This document defines the behavior contract; implementation details belong in [`docs/wiki/systems/session-autoname.md`](../wiki/systems/session-autoname.md).

## What it must do

### Trigger and title

- [x] In interactive TUI and RPC modes, after the first completed substantive real-user exchange, asynchronously ask the active model for a short 3–6 word session title.
- [x] Persist the generated title through the existing session-naming behavior.
- [x] Do not delay completion of the originating user exchange while generating the title.

### Eligibility and exclusions

- [x] Trigger only for persisted unnamed main sessions.
- [x] Do not trigger in print or JSON modes, ephemeral sessions, or child-agent sessions.
- [x] Do not trigger for already-named sessions or after later turns.
- [x] Do not trigger for non-substantive or failed exchanges.
- [x] Do not trigger from intermediate cwd-relocation events.

### Manual control and failure

- [x] A manual `/name` or `/unname` during title generation wins over the generated title.
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
- Naming ephemeral, child-agent, already-named, or later-turn sessions.
- Replacing manual session naming or defining a title policy beyond the 3–6 word contract.
