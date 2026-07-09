# Resident Architect Service

The resident Architect is a separate Pi process launched as a systemd user service. It observes the shared Pi control database, sends only material observations to `openai-codex/gpt-5.6-sol`, and relies on the model policy to post high-confidence advice through the shared channel. It does not dispatch work or make changes itself.

## Observation loop

`runArchitectService()` creates an `ArchitectObserver` and evaluates it every 30 seconds. The observer opens the control SQLite database with `createReadOnlySqliteDatabase()`, reads at most 20 distinct sessions whose health is freshly confirmed live, plus up to 20 newer `shared_channel_messages`, then closes the connection. For duplicate session IDs it retains only the newest metadata row. It does not apply the shared writer connection's WAL or pragma configuration.

The structured observer snapshot is the Architect's only session-inventory source; `list_sessions` is blocked because its global output can include historical rows unrelated to the observed state.

The first read produces an initial session-state observation. Later reads produce an observation only when either:

- the ordered session snapshot changes, including goal JSON; or
- a newly observed shared-channel message from a main session begins `Architect:`.

Messages sent by a subagent or by the Architect itself are not Architect requests. Incidental mentions such as `Re architect blocker` are also ignored; requests must begin `Architect:`. This prevents advice and surrounding discussion from retriggering the Architect. Routine unchanged observations do not call the model. The prompt contains the structured snapshot; it asks the model to use `list_sessions` only when that snapshot is insufficient.

## Advisor session and policy

The service creates or reopens `architect.jsonl` under `<agent-dir>/architect-sessions/`. This keeps the Architect's transcript separate from normal user sessions while its observer reads the same global control database and shared channel as other Pi processes.

The service requires the `openai-codex/gpt-5.6-sol` model. Its system prompt permits normal tools when useful, but prohibits agent dispatch, file edits, session restarts, and autonomous remediation. Advice must be limited to high-confidence conflicts, drift, or blockers and include affected sessions/goals plus a cheapest falsifying check. It must use `broadcast` with the affected session ID; a tool gate blocks global `channel_post` fanout.

## Tool isolation

The service uses in-memory settings with `sandboxProfile: "read-only"` and loads the bwrap extension. Pi retains its standard tools, while the bwrap extension routes file-tool workers and `bash`/`user_bash` worker processes through Bubblewrap with the workspace mounted read-only. See [bwrap-sandbox.md](bwrap-sandbox.md) for mount and environment details.

`pyrun_eval` is intentionally unavailable in this mode. The bwrap extension blocks it with a tool gate because Pyrun does not yet share the Bubblewrap worker runner. The service must not describe Pyrun as a sandboxed worker.

## Deployment

`deploy.sh` builds and installs the platform-specific compiled `pi` binary, links it at `~/.local/bin/pi`, and copies `packages/coding-agent/systemd/pi-architect.service` into the user systemd directory. The unit executes `~/.local/bin/pi architect`, has restart-on-failure behavior, and is enabled and started by deployment. Deployment reloads systemd, enables and starts the unit, then explicitly restarts it so a newly installed binary is active.
