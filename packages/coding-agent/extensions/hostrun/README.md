# Hostrun Pi Adapter

This package is the Pi adapter for `hostrun_eval`. It does not implement the Hostrun runtime,
helper library, approval request schema, or MCP server.

Canonical Hostrun source lives in `/home/osso/Repos/hostrun` and upstream
`https://github.com/Osso/hostrun`. Pi registers the tool, contributes
model-facing instructions, and delegates evaluation to a Hostrun adapter runner.

## Runtime Boundary

- Hostrun owns QuickJS session semantics, `ctx` persistence, helper APIs, command
  builders, filesystem/HTTP/CLI behavior, and approval request shapes.
- Pi owns tool registration, model prompt wiring, and Pi's wrapper approval path.
- hostrun-mcp is owned by Hostrun. Pi must not publish a duplicate
  `hostrun-mcp` binary or reimplement the MCP server.

## Runner Configuration

By default the adapter starts `hostrun-jsonl --serve`.

For local development or tests, override the runner process:

```sh
PI_HOSTRUN_RUNNER_COMMAND=node
PI_HOSTRUN_RUNNER_ARGS='["/path/to/fake-or-real-runner.mjs"]'
```

`PI_HOSTRUN_RUNNER_ARGS` is a JSON string array so paths and arguments stay
argv-based instead of shell-parsed.
