# Hostrun

First-party Pi extension package for `hostrun_eval`.

The Pi extension registers `hostrun_eval`, keeps JavaScript `ctx` state alive per
Hostrun session, and approval-gates host effects before running them.

## Pi Extension

Load the package as a Pi extension to use `hostrun_eval` inside Pi. The tool
accepts:

- `code` - JavaScript source to evaluate.
- `session_id` - optional Hostrun session key. Calls with the same session keep
  the same `globalThis.ctx`.

## MCP Server Status

`src/mcp-server.ts` exposes the tested standalone server factory for non-Pi MCP
hosts. It registers a `hostrun_eval` stdio tool descriptor and defaults host
effects to pending approval: CLI, filesystem, and HTTP helpers deny before
execution unless an approval host is wired in.

Claude Code installation is not enabled yet because the package does not publish
a `hostrun-mcp` executable. The remaining packaging step is to add the binary
entrypoint and then install it with a Claude Code MCP command such as:

```bash
claude mcp add hostrun -- hostrun-mcp
```

Track that packaging gap in `docs/specs/hostrun.md`.
