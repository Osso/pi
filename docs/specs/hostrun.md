# Hostrun

Hostrun is a stateful JavaScript host-execution extension for Pi. It registers a
`hostrun_eval` tool that exposes a persistent QuickJS session — `globalThis.ctx`
survives across evaluations within a session — and approval-gates all host
effects (filesystem, HTTP, CLI commands, search helpers) through Pi's native
`tool_call`/`ui.confirm` path. The extension can optionally run as a standalone
stdio MCP server so other MCP clients (Claude Code, etc.) can reuse the same
runtime. Source will live in
`packages/coding-agent/extensions/hostrun/` (a first-party extension package).
Implementation details belong in `docs/wiki/systems/hostrun.md`
(stub — not yet written).

## What it must do

### Extension registration and session management

- [x] Register as a Pi extension via `pi.registerTool("hostrun_eval", ...)` with
  a minimal public schema: required field `code` (string), optional
  `session_id` (string).
- [x] Evaluate `code` in a persistent QuickJS session; keep `globalThis.ctx`
  live across evaluations in the same session.
- [x] Keep separate `ctx` state per `session_id`; default a missing `session_id`
  to a per-Pi-session default Hostrun session.
- [x] Preserve `ctx` after normal JavaScript exceptions (a failing evaluation
  must not destroy session state).
- [x] Capture `console.log`, `console.info`, `console.warn`, `console.error`,
  and `console.debug` output and include it in the tool result.
- [x] Return the executed code in the result for transcript visibility.

### Approval-gated host library

- [ ] All operations with host-side effects must request approval via Pi's
  `tool_call` event / `ui.confirm` before executing; no host effect runs
  without an approval gate.
- [ ] Expose `cli.<program>(...args)` as a lazy command builder; `.run()` or a
  terminal selector triggers an approval-gated execution request.
- [ ] Expose `run.<program>(...args)` for no-capture command execution.
- [ ] Include program name and argv in the approval request for `cli.*`; never
  pass shell strings, always use argv arrays.
- [ ] Expose `fs.write(path, content)`, `fs.read(path)`, `fs.exists(path)`,
  `fs.remove(path)`, and `fs.glob(pattern, options)` as approval-gated file
  helpers.
- [ ] Expose `fs.open(path, options)` as a readable wrapper that parses JSON,
  JSONL, YAML, CSV, and TSV by extension or explicit format.
- [ ] Expose `http.get`, `http.post`, `http.put`, `http.patch`, `http.delete`,
  and `http.head` as approval-gated HTTP helpers; redact auth secrets from
  approval metadata.
- [ ] Expose `rg.search`, `rg.files`, and `rg.matches` as lazy wrappers around
  ripgrep; `rg.matches` parses `rg --json` output into structured objects.
- [ ] Expose `fd.find`, `fd.files`, and `fd.dirs` as lazy wrappers around
  `fdfind`/`fd`.
- [ ] Expose `host.cwd()` and `host.cd(path)` for persistent per-session working
  directory state; resolve relative paths against session cwd.

### MCP server option

- [ ] Provide a standalone stdio MCP server binary (`hostrun-mcp`) that exposes
  `hostrun_eval` to any MCP client without requiring the Pi coding agent.
- [ ] The standalone server defaults all host operations to pending-approval
  (never auto-approves filesystem writes, HTTP calls, or CLI commands).
- [ ] Document stdio MCP installation for Claude Code in the extension README.

## How it works

- `docs/wiki/systems/hostrun.md` (stub — not yet written).
- `docs/specs/approval-system.md` — the policy layer that gates host effects.

## Implementation inventory

- `packages/coding-agent/extensions/hostrun/` — extension root.
- `packages/coding-agent/extensions/hostrun/src/index.ts` — Pi extension entry
  point; calls `pi.registerTool("hostrun_eval", ...)` and wires the session
  store.
- `packages/coding-agent/extensions/hostrun/src/session.ts` — QuickJS session
  lifecycle, `ctx` persistence, and console capture. Host-effect helpers are
  still pending.
- `packages/coding-agent/extensions/hostrun/src/eval-tool.ts` — shared
  `hostrun_eval` argument parsing and session dispatch.
- `packages/coding-agent/extensions/hostrun/src/mcp-server.ts` — standalone
  stdio MCP server for non-Pi hosts. (planned)
- `packages/coding-agent/extensions/hostrun/package.json` — extension package
  metadata; pins `quickjs-emscripten` and is included as a root npm workspace so
  `package-lock.json` records the runtime dependency tree.

## Tests asserting this spec

- `packages/coding-agent/test/hostrun-extension.test.ts` — registration,
  per-session `ctx` persistence, console capture, and exception-survival
  coverage.

## Known gaps (current cycle)

- [x] Scaffold `packages/coding-agent/extensions/hostrun/` package.
- [x] Implement QuickJS session with persistent `ctx` and console capture.
- [ ] Implement approval-gated `cli.*`, `fs.*`, and `http.*` helpers.
- [ ] Implement `rg.*` and `fd.*` lazy wrappers.
- [x] Register extension via `pi.registerTool` in `index.ts`.
- [ ] Implement standalone `mcp-server.ts` with pending-approval default.
- [x] Add tests for `ctx` persistence across evaluations and after exceptions.
- [ ] Add tests confirming no host effect runs without an approval gate.
- [ ] Add tests for `rg.matches` structured parsing and `fd.files` output.
- [ ] Document stdio MCP install in `packages/coding-agent/extensions/hostrun/README.md`.

## Out of scope

- Shell compatibility; all command execution is argv/graph based and must not
  parse arbitrary shell syntax.
- Replacing direct repo-native commands (`cargo test`, `git`, package managers,
  deploy scripts); use those directly, not via `hostrun_eval`.
- A security sandbox for arbitrary JavaScript libraries; host effects must go
  through explicit approval-gated capabilities only.
- The full Hostrun structured-data and collection helper surface (array helpers,
  YAML/CSV/JSONL serialization, template formatting, etc.) from the Codex
  version; that can be ported incrementally after the core approval-gated
  runtime is working.
