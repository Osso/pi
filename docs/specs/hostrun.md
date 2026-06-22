# Hostrun

Hostrun is a stateful JavaScript host-execution extension for Pi. It registers a
`hostrun_eval` tool that exposes a persistent QuickJS session — `globalThis.ctx`
survives across evaluations within a session — and approval-gates all host
effects (filesystem, HTTP, CLI commands, search helpers) through Pi's native
`tool_call`/`ui.confirm` path. The tested first slice is backed by
`quickjs-emscripten`, captures console output in the structured tool details,
returns JavaScript exception details without replacing `ctx`, and keeps session
state alive after those exceptions. A later slice will add a standalone stdio
MCP server so other MCP clients (Claude Code, etc.) can reuse the same runtime.
Source lives in
`packages/coding-agent/extensions/hostrun/` (a first-party extension package)
with its runtime dependencies recorded in the root `package-lock.json`.
Implementation details belong in `docs/wiki/systems/hostrun.md`
(stub — not yet written).

## What it must do

### Extension registration and session management

- [x] Register as a Pi extension via `pi.registerTool("hostrun_eval", ...)` with
  a minimal public schema: required field `code` (string), optional
  `session_id` (string).
- [x] Load as a default first-party runtime extension so `hostrun_eval` appears
  in `pi tools` without project-local extension code.
- [x] Provide model-facing `promptSnippet` and `promptGuidelines` instructions
  for synchronous QuickJS evaluation, persistent `ctx`, and approval-gated
  Hostrun helpers whenever `hostrun_eval` is active.
- [x] Evaluate `code` in a persistent QuickJS session; keep `globalThis.ctx`
  live across evaluations in the same session.
- [x] Keep separate `ctx` state per `session_id`; default a missing `session_id`
  to a per-Pi-session default Hostrun session.
- [x] Preserve `ctx` after normal JavaScript exceptions (a failing evaluation
  must not destroy session state).
- [x] Capture `console.log`, `console.info`, `console.warn`, `console.error`,
  and `console.debug` output and include it in the tool result.
- [x] Return JavaScript exception details in the tool result without treating
  the evaluation as a transport failure.
- [x] Return the executed code in the result for transcript visibility.

### Runtime dependency packaging

- [x] Use `quickjs-emscripten` as an exact, first-party extension dependency
  rather than a scaffold evaluator or host `eval`.
- [x] Include the Hostrun extension workspace in the root npm lockfile so the
  QuickJS runtime dependency tree is reviewed with normal dependency changes.
- [x] Keep the QuickJS and schema dependencies pinned to exact versions in the
  extension package and root lockfile.

### Approval-gated host library

- [x] Tested `cli.*`, `run.*`, `fs.write`/`fs.read`/`fs.exists`/`fs.remove`/
  `fs.glob`, and `http.get`/`http.post` host effects request approval via Pi's
  `ui.confirm` path before executing.
- [x] All operations with host-side effects must request approval via Pi's
  `tool_call` event / `ui.confirm` before executing; no host effect runs
  without an approval gate.
- [x] Expose `cli.<program>(...args)` as a lazy command builder whose
  `.stdout.text()` terminal selector triggers an approval-gated execution
  request.
- [x] Expose `cli.<program>(...args).run()` as an approval-gated execution
  request returning process details.
- [x] Expose remaining `cli.<program>(...args)` terminal selectors as
  approval-gated execution requests.
- [x] Expose `run.<program>(...args)` for no-capture command execution.
- [x] Include program name and argv in the approval request for tested `cli.*`
  and `run.*`; never pass shell strings, always use argv arrays.
- [x] Include program name and argv in the approval request for all current
  `cli.*`/`run.*` helper variants;
  never pass shell strings, always use argv arrays.
- [x] Expose `fs.write(path, content)` and `fs.read(path)` as approval-gated file
  helpers.
- [x] Expose `fs.exists(path)`, `fs.remove(path)`, and `fs.glob(pattern)` as
  approval-gated file helpers.
- [x] Expose `fs.glob(pattern, options)` options support as approval-gated file
  helper behavior.
- [x] Expose `fs.open(path, options)` as a readable wrapper that parses JSON,
  JSONL, and CSV by extension or explicit format.
- [x] Extend `fs.open(path, options)` parsing coverage to YAML and TSV.
- [x] Expose `http.get(...).text()` as an approval-gated HTTP helper.
- [x] Expose `http.post(...).text()` as an approval-gated HTTP helper; redact
  auth secrets from approval metadata while preserving the real request.
- [x] Expose `http.put`, `http.patch`, `http.delete`, and `http.head` as
  approval-gated HTTP helpers; redact auth secrets from approval metadata.
- [x] Expose `rg.search`, `rg.files`, and `rg.matches` as lazy wrappers around
  ripgrep; `rg.matches` parses `rg --json` output into structured objects.
- [x] Expose `fd.find`, `fd.files`, and `fd.dirs` as lazy wrappers around
  `fdfind`/`fd`.
- [x] Expose `host.cwd()` and `host.cd(path)` for persistent per-session working
  directory state; resolve relative paths against session cwd.

### MCP server option

- [x] Provide a standalone stdio MCP server binary (`hostrun-mcp`) that exposes
  `hostrun_eval` to any MCP client without requiring the Pi coding agent.
- [x] The standalone server defaults all host operations to pending-approval
  (never auto-approves filesystem writes, HTTP calls, or CLI commands).
- [x] Document a working stdio MCP installation command for Claude Code in the
  extension README after the `hostrun-mcp` binary exists.

## How it works

- `docs/wiki/systems/hostrun.md` (stub — not yet written).
- `docs/specs/approval-system.md` — the policy layer that gates host effects.

## Implementation inventory

- `packages/coding-agent/extensions/hostrun/` — extension root.
- `packages/coding-agent/extensions/hostrun/src/index.ts` — Pi extension entry
  point; calls `pi.registerTool("hostrun_eval", ...)` and wires the session
  store.
- `packages/coding-agent/extensions/hostrun/src/session.ts` — QuickJS session
  lifecycle, `ctx` persistence, console capture, approval-gated process helpers,
  approval-gated file helpers, tested `http.get`/`http.post` helpers, and tested
  `rg.*`/`fd.*` wrappers.
- `packages/coding-agent/extensions/hostrun/src/eval-tool.ts` — shared
  `hostrun_eval` argument parsing and session dispatch.
- `packages/coding-agent/extensions/hostrun/src/mcp-server.ts` — standalone
  stdio MCP server factory for non-Pi hosts.
- `packages/coding-agent/extensions/hostrun/package.json` — extension package
  metadata; wires `hostrun-mcp` and pins `quickjs-emscripten` and `typebox` as
  exact dependencies.
- `package-lock.json` — records the Hostrun workspace and lockfile-backed
  QuickJS runtime dependency tree.

## Tests asserting this spec

- `packages/coding-agent/test/hostrun-extension.test.ts` — registration,
  per-session `ctx` persistence, console capture, and exception-survival
  coverage, including returned exception details, model-facing prompt
  instructions, approval-gated `cli.*`/`fs.*`/`http.*`/`rg.*`/`fd.*` host
  effects, denied-approval no-effect behavior, CLI terminal selectors, CLI argv
  approval metadata, parsed `fs.open` formats, and persistent `host.cwd()` /
  `host.cd(path)` behavior.
- `packages/coding-agent/test/hostrun-mcp-server.test.ts` — standalone MCP
  server registration shape, `hostrun-mcp` package wiring, README install
  command, and pending-approval defaults for CLI, filesystem, and HTTP host
  effects.
- `npm run check` — validates the workspace and lockfile state as part of the
  repo-wide verification flow.

## Known gaps (current cycle)

- [x] Scaffold `packages/coding-agent/extensions/hostrun/` package.
- [x] Implement QuickJS session with persistent `ctx` and console capture.
- [x] Implement minimal approval-gated `cli.*`, `fs.write`/`fs.read`, and
  `http.get` helpers.
- [x] Add tests confirming tested host effects do not run without an approval
  gate.
- [x] Implement tested approval-gated `cli.run`, `run.*`,
  `fs.exists`/`fs.remove`/`fs.glob`, and `http.post` helpers.
- [x] Implement tested approval-gated `fs.glob(pattern, options)`, `fs.open`
  JSON/JSONL/CSV parsing, `http.put`/`http.patch`/`http.delete`/`http.head`, and
  `host.cwd()`/`host.cd(path)` helpers.
- [x] Implement tested approval-gated CLI stdout/stderr terminal selectors and
  `fs.open` YAML/TSV parsing.
- [x] Implement `rg.*` and `fd.*` lazy wrappers.
- [x] Register extension via `pi.registerTool` in `index.ts`.
- [x] Implement standalone `mcp-server.ts` with pending-approval default.
- [x] Add tests for `ctx` persistence across evaluations and after exceptions.
- [x] Add tests for `rg.matches` structured parsing and `fd.files` output.
- [x] Add `hostrun-mcp` binary wiring and document the working stdio MCP install
  command in `packages/coding-agent/extensions/hostrun/README.md`.

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
