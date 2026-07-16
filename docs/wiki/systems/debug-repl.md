# Live-process debug REPL

The debug REPL is a first-party extension backed by a process-local Unix socket.

## Lifecycle

`/debug` starts the socket server for the current Pi process. `/debug off` destroys attached clients, closes the server, and removes the socket. The server is disabled by default.

`pi debug attach <session-id>` reads the live session health record from `control.sqlite`, resolves its exact PID, and connects to `~/.pi/agent/debug/<pid>.sock`. The socket directory and socket are owner-only.

## Runtime access

Each connection receives a Node JavaScript REPL with one `pi` root. Its `runtime`, `session`, `agent`, `services`, and `store` properties are getters. They resolve the current `AgentSessionRuntime` at evaluation time rather than retaining a session or extension context, so in-process session replacement does not make the root stale.

The REPL is intentionally privileged. Evaluated code runs inside the live Pi process with Pi's filesystem, network, credential, and mutation authority.

## Audit

Each evaluation appends an owner-only JSONL record under `~/.pi/agent/debug/audit.jsonl`. Records contain the client PID, session ID, timestamp, duration, outcome, and SHA-256 expression hash. Expression text and returned values are not persisted.
