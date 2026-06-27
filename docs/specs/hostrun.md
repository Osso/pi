# Hostrun

Module boundary: first-party extension module (`packages/coding-agent/extensions/hostrun/`) that adapts the canonical Hostrun repo; Pi must not own the runtime.

Hostrun is a stateful JavaScript host-execution runtime owned by the standalone
`https://github.com/Osso/hostrun` repository, with local source at
`/home/osso/Repos/hostrun`. Pi's `packages/coding-agent/extensions/hostrun/`
package is only an adapter: it registers `hostrun_eval`, contributes prompt
instructions, and delegates evaluation to the canonical Hostrun runner. Runtime
semantics and helper behavior belong to Hostrun, not Pi. Implementation details
belong in `docs/wiki/systems/hostrun.md` (stub — not yet written).

## What it must do

### Ownership boundary

- [x] Treat `/home/osso/Repos/hostrun` as the source of truth for QuickJS session
  semantics, helper APIs, approval request schema, command builders, and MCP
  server behavior.
- [x] Keep Pi's package as an adapter only; Pi must not implement a duplicate
  QuickJS runtime or Hostrun helper library.
- [x] Do not publish a Pi-owned `hostrun-mcp` binary; `hostrun-mcp` is owned by
  the Hostrun repository.
- [x] Do not route Pi's built-in `hostrun_eval` through MCP; use an adapter
  runner boundary like Codex's native Hostrun adapter.

### Extension registration

- [x] Register `hostrun_eval` through `pi.registerTool` with required `code`
  and optional `session_id` parameters.
- [x] Require Pi wrapper approval before delegating `hostrun_eval` to the
  canonical runner.
- [x] Provide model-facing instructions that identify Hostrun as synchronous,
  persistent, and adapter-backed.

### Runner delegation

- [x] Start an argv-based Hostrun runner process (`hostrun-jsonl --serve` by
  default, overridable with `PI_HOSTRUN_RUNNER_COMMAND` and
  `PI_HOSTRUN_RUNNER_ARGS`).
- [x] Resolve the default Hostrun runner from the local debug build, the user's installed
  `~/.cargo/bin/hostrun-jsonl`, or `hostrun-jsonl` on `PATH` so restarted runtimes do not depend on
  a single development build path.
- [x] Send each `hostrun_eval` request to the runner as JSONL instead of
  evaluating JavaScript in Pi.
- [x] Keep session state in the runner process across evaluations for the same
  `session_id`.
- [x] Return canonical Hostrun `completed` results, console messages, and
  `needs_approval` approval requests without translating them into Pi-local
  helper shapes.
- [x] Surface canonical Hostrun in-progress/status output for long-running
  `hostrun_eval` requests while the runner is still evaluating, without waiting
  for the final `completed` result.

## How it works

- `docs/wiki/systems/hostrun.md`
- `/home/osso/Repos/hostrun/docs` and `/home/osso/Repos/hostrun/README.md`
- `/home/osso/Repos/codex/docs/wiki/systems/hostrun.md`

## Implementation inventory

- `packages/coding-agent/extensions/hostrun/src/index.ts` — Pi extension
  registration and prompt contribution.
- `packages/coding-agent/extensions/hostrun/src/eval-tool.ts` — maps Pi tool
  calls to runner requests and formats model-visible results.
- `packages/coding-agent/extensions/hostrun/src/runner.ts` — persistent JSONL
  client for the canonical Hostrun runner process.
- `packages/coding-agent/extensions/hostrun/README.md` — adapter boundary and
  local runner configuration.
- `packages/coding-agent/extensions/hostrun/package.json` — adapter package
  metadata; intentionally no QuickJS dependency and no `hostrun-mcp` binary.

## Tests asserting this spec

- `packages/coding-agent/test/hostrun-extension.test.ts` — tool registration,
  runner delegation, default runner resolution, session persistence at the runner boundary, and
  canonical Hostrun result/update shapes.
- `packages/coding-agent/test/hostrun-adapter-package.test.ts` — package
  boundary checks proving Pi does not publish `hostrun-mcp` or depend on
  QuickJS.
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts` —
  wrapper approval behavior for `hostrun_eval`.

## Known gaps (current cycle)

- [x] Add the canonical `hostrun-jsonl` runner in `/home/osso/Repos/hostrun`;
  Pi expects this non-MCP runner boundary instead of owning runtime code.
- [x] Add tests and adapter wiring for in-progress `hostrun_eval` runner output.
- [ ] Write `docs/wiki/systems/hostrun.md` for Pi's adapter wiring after the
  runner binary is available.

## Out of scope

- Reimplementing Hostrun helpers, parsers, process management, filesystem
  behavior, HTTP behavior, or approval request generation in Pi.
- Owning Hostrun's MCP server from Pi.
- Shell-string compatibility; Hostrun command execution remains argv/graph
  based in the Hostrun repository.
