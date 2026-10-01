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

## Mailbox API Boundary

`pi.messages.send` and `pi.messages.enqueue` remain programmatic raw literal-body transport
APIs; their body and routing contracts are unchanged.

Model-facing `send_agent_message` and `contact_parent` instead accept metadata plus optional
`textIndex`, not `message: string`. They send verbatim text from the executing assistant
response matched by both the expected mailbox tool name and exact `toolCallId`. `textIndex` selects a zero-based filtered text block;
multiple blocks require it, while one block is selected by default. Missing, unmatched,
empty, or ambiguous source text fails without compatibility or stale-transcript fallback.

A synthetic `pi.tools.call` mailbox invocation must fail explicitly: reusing the outer
`pyrun_eval` ID does not match the mailbox tool name and cannot send outer commentary.
Use the raw messaging APIs for programmatic literal bodies, not a mailbox-tool wrapper. Commentary is never automatically broadcast, and `spawn_agent.prompt` is unchanged.
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
