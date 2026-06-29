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

## Runner Configuration

By default the adapter starts `pyrun-jsonl` with no arguments.

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
