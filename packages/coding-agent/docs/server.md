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

Supported commands are `hello`, `list_machines` (hub only, see [Hub](#hub)), `list_sessions`, `start_session`, `stop_session`, `delete_session`, `rename_session`, `archive_session`, `attach_session`, `detach_session`, `session_rpc`, `list_questions`, and `answer_question`. The server emits `session_updated`, `session_event`, and question updates while subscribed. `list_sessions` returns every session that runs now and the ended sessions `pi -r` offers (indexed, not archived, not a sub-agent, with at least one message). An entry in the resume index has `firstMessage`, which clients show when `name` is null. The configured Supervisor session (`supervisor.sessionId`) has the name `Supervisor` when it has no name of its own. `delete_session {sessionId}` deletes an ended session and its sub-agent transcripts as `pi -r` does (to the trash when the `trash` command exists); a running session fails with `running`. `rename_session {sessionId, name}` sets a session's name (an empty or absent `name` clears it); a server worker renames its own session, and a running terminal session fails with `running`. `archive_session {sessionId}` archives an ended session as `pi -r` does (its transcript is compressed and leaves the list); a running session fails with `running`. Session ownership distinguishes server-managed RPC workers from external sessions. External running sessions are read-only and use terminal attachment metadata; RPC attach and server stop are not available for them.

A session attachment includes a snapshot of RPC state, messages, and agents plus a runtime instance ID and event sequence. Frames are JSON lines of up to 64 MiB, so the snapshot of a long session fits in one frame; a larger frame closes the connection. Send RPC commands inside `session_rpc`; the server maps inner request IDs to the worker. Observers can request state only. Control attachments can mutate the same session. The server rejects `new_session`, `switch_session`, `fork`, and `clone` inside `session_rpc`. A dialog answer (`extension_ui_response`) goes to the worker with its dialog `id` and gets an immediate success response. `prompt`, `steer`, and `follow_up` have no response time limit, because an extension command such as `/delete` answers only after its dialog closes; other RPC commands fail after 30 seconds. `/delete` and `/archive` end the worker, and the session leaves `list_sessions`.

`hello` reports `questionStoreHost`: the configured `supervisor.host`, or this host when no Supervisor host is set. `list_questions` returns direct user questions on the current host and escalated questions only on the Supervisor host. Questions under Supervisor or parent review, child-agent questions, and unsupervised TUI dialogs are not included in this slice. Clients merge `list_questions` results from every machine. Answer a direct question on its origin host; answer an escalated question on the Supervisor host. A question ID that belongs to another host returns `not_found`.

`stop_session` ends the worker and returns `{ session }` with the session's ended summary from the session directory. A session that never persisted a transcript leaves the directory when its worker exits; the response is then its last directory entry with `status: "ended"`, `owner: "external"` and `attachment: "none"`. A worker that already exited on its own is no longer owned, so `stop_session` for it fails with `not_managed`.

## Hub

One machine is the hub; clients such as pi-desktop connect to the hub only, and the hub reaches every other machine (a spoke). Set `server.hub` in pi settings to the hub's SSH destination on every machine:

```json
{ "server": { "hub": "agent-server" } }
```

- On the hub, `server.hub` equals the local host ID (`PI_SERVER_HOST_ID`, else the hostname). The hub accepts spoke links.
- On any other host, `pi server` keeps one outbound link to the hub and reconnects after it ends, with exponential backoff from 1 s to 30 s with jitter. Spokes dial out, so a laptop behind NAT works.
- Without `server.hub`, `pi server` runs alone, as before.

The link command is `server.hubCommand` (an argv array). The default is:

```sh
ssh -T -o BatchMode=yes -o ConnectTimeout=10 <hub> ~/.local/bin/pi server --link
```

A non-interactive SSH shell often does not have `~/.local/bin` on `PATH`, so `ssh <hub> pi ...` fails with `pi: command not found`. The default names the installed binary, and the remote shell expands `~`. If pi is installed somewhere else on the hub, set `server.hubCommand`, for example `["ssh", "-T", "agent-server", "/usr/bin/pi", "server", "--link"]`. The command must start a JSONL stream to the hub's `pi server` on stdin and stdout.

`pi server --link` is the hub end of the link. Like `--stdio`, it connects stdin and stdout to the local socket. The spoke sends `{"type":"link_hello","version":1,"hostId","serverInstanceId"}` first. The hub answers `{"type":"link_hello_ack","version":1,"hostId"}`, or `{"type":"link_hello_rejected","error":{code,message}}` and closes. Codes: `not_hub`, `invalid_link_hello`, and `duplicate_host` (another link for the same `hostId` is still connected; a link replaces an earlier one only after that one has closed).

### Routing

Client frames take an optional `hostId`.

- No `hostId`, or the hub's own `hostId`: the hub handles the frame locally.
- Another `hostId`: the hub forwards the frame over that spoke's link with its own request ID, and returns the spoke's response with the client's `id` and `hostId` added. All protocol v1 commands work this way. A frame for an offline or unknown machine fails with `machine_offline`; a forwarded request that is pending when the link drops fails with `machine_offline` as well. A `hostId` on a server that is not the hub fails with `not_hub`.
- Attachments, control, and subscriptions stay per client connection on the spoke. When a hub client disconnects, the spoke releases its attachments.
- `session_event` frames from a spoke have `hostId`. Events from the hub itself can omit `hostId`.

### Machines and aggregated lists

`list_machines` returns `{ machines: [{ hostId, status: "online"|"offline", lastSeenAt, serverInstanceId? }] }`, with the hub first. `serverInstanceId` is present only while the machine is online. The request subscribes the connection to `{ "type":"machine_updated", "machine": { hostId, status, lastSeenAt, serverInstanceId? } }`.

On the hub, every entry in `list_sessions` and `list_questions` has `hostId`.

- With no `hostId`, the result has the hub's entries and the last known entries of every spoke. Spoke entries have `stale: false` while the spoke is online and `stale: true` while it is offline. The hub keeps the snapshots current from the spoke's `session_updated`, `session_removed`, and `question_updated` events. A pending question that ends without an answer (its dialog is dismissed or its worker stops) gets a `question_updated` with `state: "cancelled"`. Those events reach hub clients with `hostId` and the spoke's own `revision`; revisions are per machine.
- With the hub's `hostId`, the result has only the hub's entries.
- With a spoke's `hostId`, the spoke answers. When a spoke comes back online, clients should send `list_sessions` and `list_questions` with that `hostId` again to refresh it. The hub also sends `{ "type":"resync_required", "scope":"sessions"|"questions", "hostId" }` after it reloads a spoke's snapshot.

An offline spoke keeps its last snapshot on the hub until it reconnects. The hub keeps snapshots in memory only.

### Sub-agents on another machine

`spawn_agent` with `host` (a host ID such as `aso`) and optional `cwd` (default: the parent's cwd) runs the child as a worker on that machine through the hub. The parent connects to the hub as a protocol client: over the local socket on the hub, else with the `server.hubCommand` link command. It sends `start_session` with `hostId`, `cwd`, and the child's display name, `attach_session` in control mode, and the assignment as a `session_rpc` `prompt`. The child is complete at its run's `agent_settled` event; its last reply is the result that `wait_agent`, the agent list, and the parent's mailbox receive, as for a local child. Then the parent sends `stop_session`.

- The child is a fresh main session on that machine, with its default model and tools; `context: "inherit"` is refused. Its assignment ends with the parent's session ID and host, so it can use `send_agent_message` with `toHost` over the [relay](../../../docs/specs/multi-agent.md#cross-host-messaging) before it finishes.
- The agent records `transcript: { host, sessionId }` and no local path. When the parent restarts, the worker keeps running; the restarted parent attaches to it again, does not prompt it again, and waits until it is idle. `close_agent` sends `abort` to the worker.
- `steer_agent` is not delivered to a remote child.

## Limits

The server records the sessions its workers own in `server-sessions.json` in the agent directory. When it starts, it reopens each recorded session whose worker was killed with the server (a restart, a signal, a crash); a reopened worker continues an interrupted run as any resumed session does. A session stopped with `stop_session`, or whose worker quit with exit code 0, is not reopened. A session that has a live writer elsewhere, or that left the session directory, is skipped and forgotten. Use `pi server --help` is not currently supported; see this page for the v1 contract.
