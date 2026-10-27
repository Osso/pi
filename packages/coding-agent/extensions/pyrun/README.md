# Pyrun Pi Adapter

This package is the Pi adapter for `pyrun_eval`. It does not implement the Pyrun runtime,
helper library, approval request schema, or MCP server.

Canonical Pyrun source lives in `/syncthing/Sync/Projects/claude/pyrun`. Pi registers the
tool, contributes model-facing instructions, and delegates evaluation to a Pyrun JSONL runner.

## Runtime Boundary

- Pyrun owns Python session semantics, persistent `ctx`, helper APIs, command builders,
  filesystem/HTTP/CLI behavior, and approval request shapes.
- Pi owns tool registration, model prompt wiring, and Pi's wrapper approval path.
- pyrun-mcp is owned by Pyrun. Pi must not publish a duplicate `pyrun-mcp` binary or
  reimplement the MCP server.

Foreground Pyrun does not require a persisted main session. [Standalone workers](../../../../docs/specs/standalone-worker.md) use the same canonical JSONL runner without Supervisor or durable backgrounding; orchestration bridge APIs are unavailable. Ordinary session behavior is unchanged.

## Mailbox API Boundary

Pi-hosted Pyrun requests `agents.send_message` and `agents.steer` execute the active
`send_agent_message` and `steer_agent` tools respectively. Their payloads use the native
camelCase tool fields, including `body` for send and `agentId` and `message` for steer.
Native validation and execution errors propagate as bridge errors.

`pi.messages.send` and `pi.messages.enqueue` remain independent programmatic raw literal-body
transport APIs; their `message` field and routing contracts are unchanged. Do not rename
that transport field to `body`.

Native `send_agent_message` and `contact_parent` require a nonblank `body` string, sent
verbatim. Assistant narration, reasoning, and transcript text are never read to obtain it.
No accompanying assistant text is required; multiple calls can send distinct bodies.

`pi.tools.call` uses native parameters, including required `body`:

```python
pi.tools.call("send_agent_message", {"toAgentId": "agent_7", "body": "Review complete."})
pi.tools.call("contact_parent", {"body": "Review complete."})
```

Migration: move the outgoing assistant-text message into `body` and remove `textIndex`.
Native tools do not accept `message` as an alias. Missing or blank bodies fail explicitly;
there is no compatibility or implicit-text fallback. Commentary is never automatically
broadcast, and `spawn_agent.prompt` is unchanged.
See [mailbox migration examples](../../../../docs/wiki/systems/multi-agent.md#model-facing-mailbox-body-and-migration).

## Runner Configuration

By default the adapter starts the installed `pyrun-jsonl` with no arguments. `pyrun_eval` is registered only when the selected runner command is executable; missing runners are non-fatal and Pi never installs them. First-party Pyrun availability is selected at Pi startup, so restart Pi after installing, removing, or changing the runner command. Explicitly loaded Pyrun factories guard registration whenever they load. A local checkout is never selected implicitly.

For local development or tests, override the runner process:

```sh
PI_PYRUN_RUNNER_COMMAND=node
PI_PYRUN_RUNNER_ARGS='["/path/to/fake-or-real-runner.mjs"]'
```

To run the local Pyrun checkout with Python instead of an installed `pyrun-jsonl`, expose the
runtime on `PYTHONPATH` and opt in explicitly:

```sh
PYTHONPATH=/syncthing/Sync/Projects/claude/pyrun \
PI_PYRUN_RUNNER_COMMAND=python \
PI_PYRUN_RUNNER_ARGS='["-m","pyrun.jsonl"]'
```

`PI_PYRUN_RUNNER_ARGS` is a JSON string array so paths and arguments stay argv-based instead
of shell-parsed.

Detached Pyrun evaluations register a multi-agent runtime abort handle. Cancelling the
background job aborts the evaluation and terminates the runner process group, including
commands spawned by the runner, so no child process survives as an orphan.
