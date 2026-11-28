# First-party `ask_secret` tool

The first-party `ask_secret` extension provides two secret-entry flows for interactive TUI and RPC sessions: typed browser credential provisioning and single-value file persistence. Source implementation details belong in [`docs/wiki/systems/ask-secret-tool.md`](../wiki/systems/ask-secret-tool.md).

## What it must do

### Tool surface

- [x] Accept browser credential requests only as `{ record, fields: [{ type, name, selector }] }`, where `fields` has one or more ordered entries and each type is `text`, `email`, or `password`; reject the replaced `{ record, usernameSelector, passwordSelector }` shape.
- [x] Accept single-value file requests with `{ path, label }`.
- [x] Publish parameters as one top-level object schema, and reject requests that mix or omit members of the two shapes before prompting.
- [x] Require approval before either secret-entry flow executes.
- [x] Run only when the session has a UI and runs in TUI or RPC mode; fail closed in every other mode, and in RPC mode without a UI.
- [x] In RPC mode, send each masked prompt as an `input` request with `secret: true`; send `secret` only when true.

### Browser credential flow

- [x] Prompt for each requested browser field in order using its name; mask only `password` fields, then pass field metadata and values separately to the typed Secrets Broker browser-record path.
- [x] Return only non-secret provisioning metadata.
- [x] Reject unsafe broker arguments before prompting.

### Single-value file flow

- [x] Validate an absolute destination path and non-empty label before prompting.
- [x] Prompt exactly once with masked input.
- [x] Return cancellation metadata and leave the destination absent when input is cancelled.
- [x] Persist the entered value followed by exactly one newline.
- [x] Create missing parent directories with owner-only permissions and write the destination with owner-only permissions.
- [x] Atomically overwrite an existing regular file.
- [x] Reject symbolic-link and non-regular destinations before prompting.
- [x] Write through a same-directory temporary file and atomic rename without leaving temporary files after success or rename failure.

### Secret handling and filesystem boundary

- [x] Do not include entered secrets in returned tool results.
- [ ] Keep entered secrets out of tool arguments, logs, and persisted session transcript data (the persisted transcript has real-process proof for an RPC file request).
- [ ] Document that filesystem permissions and subsequent tool access govern the saved file after persistence; `ask_secret` does not return or read the value back.

## How it works

- [`docs/wiki/systems/ask-secret-tool.md`](../wiki/systems/ask-secret-tool.md) (stub — not yet written).
- [`packages/coding-agent/docs/extensions.md`](../../packages/coding-agent/docs/extensions.md) — user-facing extension behavior and mode restrictions.

## Implementation inventory

- `packages/coding-agent/extensions/ask-secret/src/index.ts` — tool schemas, TUI/RPC guards, browser provisioning, file validation, and atomic file persistence.
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — sends `secret: true` on masked RPC `input` requests.
- `packages/coding-agent/test/ask-secret.test.ts` — behavioral coverage for schema-driven browser prompts, both flows, cancellation, validation, permissions, overwrite, destination rejection, and TUI/RPC mode guards.
- `packages/coding-agent/test/suite/rpc-ask-secret.test.ts` — real-process RPC file request.

## Tests asserting this spec

- `packages/coding-agent/test/ask-secret.test.ts` — `preserves browser provisioning and returns only non-secret metadata`.
- `packages/coding-agent/test/ask-secret.test.ts` — `prompts once with masked input and returns only non-secret file metadata`.
- `packages/coding-agent/test/ask-secret.test.ts` — `returns cancelled metadata without writing when single-value input is cancelled`.
- `packages/coding-agent/test/ask-secret.test.ts` — `rejects invalid single-value requests before prompting` and `rejects unsafe broker arguments before prompting`.
- `packages/coding-agent/test/ask-secret.test.ts` — `writes the exact secret with a trailing newline using owner-only permissions`, `atomically overwrites an existing regular file`, `rejects a symlink destination before prompting`, `rejects a non-regular destination before prompting`, and both RPC-without-UI failure tests.
- `packages/coding-agent/test/ask-secret.test.ts` — `prompts through an RPC client UI and masks only password fields` and `writes a file secret entered through an RPC client UI as a secret input`.
- `packages/coding-agent/test/suite/rpc-ask-secret.test.ts` — `asks the client for a masked value, writes it to the file and keeps it out of the session`.

## Known gaps (current cycle)

- [ ] Add behavioral proof that no secret reaches logs, and transcript proof for the TUI and browser flows.
- [ ] Add a durable wiki page describing the implementation and filesystem trust boundary.

## Out of scope

- JSON, print-mode, or other non-UI secret prompting.
- Reading a saved file back into tool results or the model context.
- Treating a raw file as a typed Secrets Broker credential record.
- Enforcing access policy after persistence beyond normal filesystem permissions and later tool authorization.
- Relative destination paths or symbolic-link destinations.
