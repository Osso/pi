# First-party `ask_secret` tool

The first-party `ask_secret` extension provides two interactive-TUI-only secret-entry flows: typed browser credential provisioning and single-value file persistence. Source implementation details belong in [`docs/wiki/systems/ask-secret-tool.md`](../wiki/systems/ask-secret-tool.md).

## What it must do

### Tool surface

- [x] Accept browser credential requests with `{ record, usernameSelector, passwordSelector }`.
- [x] Accept single-value file requests with `{ path, label }`.
- [x] Require approval before either secret-entry flow executes.
- [x] Fail closed outside an interactive TUI session.

### Browser credential flow

- [x] Prompt for username and masked password, then provision through the existing typed Secrets Broker browser-record path.
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
- [ ] Keep entered secrets out of tool arguments, logs, and persisted session transcript data.
- [ ] Document that filesystem permissions and subsequent tool access govern the saved file after persistence; `ask_secret` does not return or read the value back.

## How it works

- [`docs/wiki/systems/ask-secret-tool.md`](../wiki/systems/ask-secret-tool.md) (stub — not yet written).
- [`packages/coding-agent/docs/extensions.md`](../../packages/coding-agent/docs/extensions.md) — user-facing extension behavior and mode restrictions.

## Implementation inventory

- `packages/coding-agent/extensions/ask-secret/src/index.ts` — tool schemas, TUI guards, browser provisioning, file validation, and atomic file persistence.
- `packages/coding-agent/test/ask-secret.test.ts` — behavioral coverage for both flows, cancellation, validation, permissions, overwrite, and destination rejection.

## Tests asserting this spec

- `packages/coding-agent/test/ask-secret.test.ts` — `preserves browser provisioning and returns only non-secret metadata`.
- `packages/coding-agent/test/ask-secret.test.ts` — `prompts once with masked input and returns only non-secret file metadata`.
- `packages/coding-agent/test/ask-secret.test.ts` — `returns cancelled metadata without writing when single-value input is cancelled`.
- `packages/coding-agent/test/ask-secret.test.ts` — `rejects invalid single-value requests before prompting` and `rejects unsafe broker arguments before prompting`.
- `packages/coding-agent/test/ask-secret.test.ts` — `writes the exact secret with a trailing newline using owner-only permissions`, `atomically overwrites an existing regular file`, `rejects a symlink destination before prompting`, `rejects a non-regular destination before prompting`, and both non-TUI failure tests.

## Known gaps (current cycle)

- [ ] Add behavioral proof that no secret reaches logs or persisted transcript data.
- [ ] Add a durable wiki page describing the implementation and filesystem trust boundary.

## Out of scope

- Non-interactive, RPC, JSON, or print-mode secret prompting.
- Reading a saved file back into tool results or the model context.
- Treating a raw file as a typed Secrets Broker credential record.
- Enforcing access policy after persistence beyond normal filesystem permissions and later tool authorization.
- Relative destination paths or symbolic-link destinations.
