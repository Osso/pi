# Pi Server

`pi server` runs a per-user session host. It owns RPC workers until they stop or the server exits. Client disconnects detach only the client; they do not stop a worker.

## Run

Start the resident service with:

```sh
pi server
```

The server listens on `$XDG_RUNTIME_DIR/pi/server.sock`. It creates the parent directory with mode `0700` and the socket with mode `0600`. `XDG_RUNTIME_DIR` must be set.

Connect over the local socket with a client, or use SSH stdio on a remote host:

```sh
ssh agent-server pi server --stdio
```

`--stdio` forwards JSONL frames to the resident socket. It does not start the daemon or own workers. Install `systemd/pi-server.service` as a user unit to run the daemon under systemd. Enable linger separately only on hosts where the user requires service operation after logout.

## Protocol v1

Each request and response is one JSON object per line. Every client request has a connection-scoped `id`. Responses use `{ "type":"response", "id", "command", "success", "data" }`; failures contain `{ "code", "message" }`. Send `hello` with version `1` before commands.

Supported commands are `hello`, `list_sessions`, `start_session`, `stop_session`, `attach_session`, `detach_session`, `session_rpc`, `list_questions`, and `answer_question`. The server emits `session_updated`, `session_event`, and question updates while subscribed. Session ownership distinguishes server-managed RPC workers from external sessions. External running sessions are read-only and use terminal attachment metadata; RPC attach and server stop are not available for them.

A session attachment includes a snapshot of RPC state, messages, and agents plus a runtime instance ID and event sequence. Send RPC commands inside `session_rpc`; the server maps inner request IDs to the worker. Observers can request state only. Control attachments can mutate the same session. The server rejects `new_session`, `switch_session`, `fork`, and `clone` inside `session_rpc`.

`hello` reports `questionStoreHost`: the configured `supervisor.host`, or this host when no Supervisor host is set. `list_questions` returns direct user questions on the current host and escalated questions only on the Supervisor host. Questions under Supervisor or parent review, child-agent questions, and unsupervised TUI dialogs are not included in this slice. Clients merge `list_questions` results from every machine. Answer a direct question on its origin host; answer an escalated question on the Supervisor host. A question ID that belongs to another host returns `not_found`.

`stop_session` ends the worker and returns `{ session }` with the session's ended summary from the session directory. A session that never persisted a transcript leaves the directory when its worker exits; the response is then its last directory entry with `status: "ended"`, `owner: "external"` and `attachment: "none"`. A worker that already exited on its own is no longer owned, so `stop_session` for it fails with `not_managed`.

The daemon does not recover active turns after a daemon or host failure. Resume an ended transcript explicitly. Use `pi server --help` is not currently supported; see this page for the v1 contract.
