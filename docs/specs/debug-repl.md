# Live-process debug REPL

The live-process debug REPL provides explicitly enabled, privileged JavaScript access to a running Pi session for runtime diagnosis. Runtime details belong in [`docs/wiki/systems/debug-repl.md`](../wiki/systems/debug-repl.md).

## What it must do

### Activation and attachment

- [x] `/debug` routes through the registered extension command and enables a process-local debug endpoint for the current session.
- [x] `/debug off` closes the endpoint and attached clients.
- [x] `pi debug attach <session-id>` resolves the exact live session PID before connecting.
- [x] Keep the endpoint inaccessible to other OS users through owner-only directory and socket permissions.

### Runtime access

- [x] Expose one `pi` root with live runtime, session, agent, services, and multi-agent store access.
- [x] Resolve runtime state at evaluation time so session replacement does not leave captured stale session objects in the root.
- [x] Permit privileged JavaScript evaluation intentionally; activation is an explicit operator action.
- [x] Allow a client to exit or disconnect while an asynchronous evaluation is pending; settlement and audit may complete, but the server must not write to the closed client or crash Pi.

### Audit

- [x] Record client-reported PID, live session ID, duration, settled outcome, timestamp, and a SHA-256 expression hash.
- [x] Never record expression text or returned values in the audit log.

## How it works

- [`docs/wiki/systems/debug-repl.md`](../wiki/systems/debug-repl.md) — runtime architecture (stub).

## Implementation inventory

- `packages/coding-agent/src/core/debug-repl.ts` — owns the Unix socket, REPL sessions, live root, and audit records.
- `packages/coding-agent/extensions/debug/src/index.ts` — implements `/debug` and `/debug off`.
- `packages/coding-agent/src/cli/debug-command.ts` — implements external session attachment.
- `packages/coding-agent/src/main.ts` — registers the extension, CLI command, and live runtime accessor.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — routes `/debug` through ordinary extension-command dispatch without a competing legacy implementation.

## Tests asserting this spec

- `packages/coding-agent/test/debug-repl.test.ts` — live runtime resolution and secret-safe audit behavior.
- `packages/coding-agent/test/debug-extension.test.ts` — command activation lifecycle.
- `packages/coding-agent/test/debug-command.test.ts` — exact live-session socket resolution.
- `packages/coding-agent/test/suite/debug-repl-headless.test.ts` — real-process activation, attachment, evaluation, and live state across session replacement.
- `packages/coding-agent/test/interactive-mode-startup-input.test.ts` — interactive `/debug` dispatches through the registered extension command.

## Known gaps (current cycle)

None.

## Out of scope

- Remote or TCP attachment.
- Read-only evaluation or capability sandboxing; this interface is deliberately privileged.
- Compatibility guarantees for internal runtime object shapes exposed through `pi.runtime`.
