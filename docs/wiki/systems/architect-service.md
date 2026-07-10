# Resident Architect Service

The resident Architect is a separate Pi process launched as a systemd user service. It observes the shared Pi control database, sends only material observations to `openai-codex/gpt-5.6-sol`, and relies on the model policy to post high-confidence advice through the shared channel. It does not dispatch work or make changes itself.

## Observation loop

`runArchitectService()` creates an `ArchitectObserver` and evaluates it every 30 seconds. The observer opens the control SQLite database with `createReadOnlySqliteDatabase()`, uses SQL to prefilter at most 20 current main sessions to a current main listener with matching fresh `ok` health, plus up to 20 newer `shared_channel_messages`, then closes the connection. It excludes subagents and the Architect itself, retains the most recently registered main-session listener for each live process, and uses deterministic metadata ordering for duplicate session IDs. Historical sessions that share a PID do not reappear as current work. Live runtimes refresh their listener and health every 60 seconds, keeping long-running sessions inside the five-minute freshness window. It does not apply the shared writer connection's WAL or pragma configuration.

The model receives only the bounded structured session projection, not raw listener or health fields. That snapshot is the Architect's sole session-inventory source by policy. `list_sessions` is also current-binding-aware, but remains blocked so Architect conclusions use the bounded snapshot that triggered the observation.

On startup the observer advances its shared-channel cursor to the current tail, so historical `Architect:` requests cannot replay after a service restart. The first read produces an initial session-state observation. Later reads produce an observation only when either:

- the ordered session snapshot changes, including goal JSON; or
- a newly observed shared-channel message from a main session begins `Architect:`.

Messages sent by a subagent or by the Architect itself are not Architect requests. Incidental mentions such as `Re architect blocker` are also ignored; requests must begin `Architect:`. An explicit request remains a durable event even if its sender exits before the next observer cycle; the current bounded session snapshot separately supplies liveness evidence. This prevents advice and surrounding discussion from retriggering the Architect without discarding requested review work. Routine unchanged observations do not call the model. The prompt contains the structured snapshot and forbids querying `list_sessions`, so all inventory conclusions stay anchored to the bounded observation that triggered the turn.

## Advisor session and policy

The service creates or reopens `architect.jsonl` under `<agent-dir>/architect-sessions/`. This keeps the Architect's transcript separate from normal user sessions while its observer reads the same global control database and shared channel as other Pi processes.

The service requires the `openai-codex/gpt-5.6-sol` model. Its system prompt permits normal tools when useful, but prohibits agent dispatch, file edits, session restarts, and autonomous remediation. `goal_json.completedAt` means only that autonomous goal continuation has completed; it is not session-termination evidence. Consecutive control-SQLite snapshots can retain the same active main-session IDs while a goal is paused or completed. Architect uses session membership in the prefiltered bounded snapshot, never goal fields, as liveness evidence; it cannot inspect listener or health evidence directly. Sessions omitted because `is_subagent = 1` are intentionally excluded from Architect's main-session inventory. Advice must be limited to high-confidence conflicts, drift, or blockers and include affected sessions/goals plus a cheapest falsifying check. It must use `broadcast` with the affected session ID; a tool gate blocks global `channel_post` fanout.

## Tool isolation

The service uses in-memory settings with `sandboxProfile: "read-only"` and loads the bwrap and default Pyrun extensions. Pi retains its standard tools while the bwrap extension routes file-tool workers, `bash`/`user_bash`, and Pyrun's runner process through Bubblewrap with the workspace mounted read-only. Pyrun is available in this mode, but its Pi bridge is disabled: it receives no Pi capability snapshot and cannot make bridge requests. Hostrun is not default-loaded; if an Architect configuration explicitly loads it, its runner uses the same bwrap path with its Pi bridge disabled.

Enabled host-side extension tools and hooks remain trusted capabilities outside that selected worker-routing boundary. This is not a confidentiality boundary against the trusted Architect or trusted enabled extensions. It limits selected worker filesystem/process access and prevents sandboxed runtimes from using Pi bridge capabilities. See [bwrap-sandbox.md](bwrap-sandbox.md) for mount and environment details.

## Deployment

`deploy.sh` builds and installs the platform-specific compiled `pi` binary, links it at the configured deployment bin directory, and renders `packages/coding-agent/systemd/pi-architect.service` into the user systemd directory with that exact binary path. The unit has restart-on-failure behavior and is enabled and started by deployment. Deployment reloads systemd, enables and starts the unit, explicitly restarts it so a newly installed binary is active, then requires `systemctl --user is-active --quiet pi-architect.service` to succeed.
