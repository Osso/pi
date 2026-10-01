# Live-process debug REPL

Contract: [Debug REPL](../../specs/debug-repl.md).

The debug REPL is a first-party extension backed by a process-local Unix socket.

## Lifecycle

`/debug` starts the socket server for the current Pi process. `/debug off` destroys attached clients, closes the server, and removes the socket. The server is disabled by default.

`pi debug attach <session-id>` requires a PID and `ok` status in the session's control-DB health row, then connects to `<agent-dir>/debug/<pid>.sock`. The agent directory follows [configuration path resolution](config-location.md); the socket directory and socket are owner-only. The socket handshake supplies the expected session ID.

## Runtime access

Each connection receives a runtime-neutral JavaScript REPL backed by a persistent `node:vm` context with one `pi` root. Its `runtime`, `session`, `agent`, `services`, and `store` properties are getters. They resolve the current `AgentSessionRuntime` at evaluation time rather than retaining a session or extension context, so in-process session replacement does not make the root stale.

The REPL is intentionally privileged. Evaluated code runs inside the live Pi process with Pi's filesystem, network, credential, and mutation authority. Internal object shapes are not a stable public API.

Evaluations are serialized per connection. `.exit` closes the client even when an asynchronous evaluation is pending; that evaluation can still settle and be audited. `evaluateLine()` checks socket writability before returning output, preventing a late result from writing to the closed connection.

## Audit

Each evaluation appends an owner-only JSONL record under `<agent-dir>/debug/audit.jsonl`. Records contain the client-reported PID, live session ID, timestamp, duration, settled outcome, and SHA-256 expression hash. Expression text and returned values are not persisted.

## Source and coverage

[debug-repl.ts](../../../packages/coding-agent/src/core/debug-repl.ts) owns the socket, live root, evaluation queue, and audit. The [debug extension](../../../packages/coding-agent/extensions/debug/src/index.ts) owns command activation, and [debug-command.ts](../../../packages/coding-agent/src/cli/debug-command.ts) resolves external attachment.

[REPL tests](../../../packages/coding-agent/test/debug-repl.test.ts), [extension tests](../../../packages/coding-agent/test/debug-extension.test.ts), and [attachment tests](../../../packages/coding-agent/test/debug-command.test.ts) cover their respective boundaries. The [headless fixture test](../../../packages/coding-agent/test/suite/debug-repl-headless.test.ts) exercises real-process attachment and session replacement. These are coverage locations, not fresh test results.
