# Safe mode capability restriction

Module boundary: first-party extension module.

Safe mode is a session-local Pi extension at `packages/coding-agent/extensions/safe/src/index.ts`. It provides `/safe on|off|status` to restrict model-initiated tool calls without claiming to be an OS sandbox.

## What it must do

### Command surface

- [x] Register `/safe` as a first-party slash command.
- [x] Accept `/safe on`, `/safe off`, and `/safe status`.
- [x] Treat missing or invalid arguments as status or usage feedback without changing tool policy.
- [x] Expose simple argument completions for `on`, `off`, and `status`.

### Capability restriction

- [x] Keep safe mode session-local and disabled by default.
- [x] When enabled, allow only `web_search` and `ask_questions` tool calls.
- [x] When enabled, block all other tools, including built-in shell/file/search tools, `pyrun_eval`, `hostrun_eval`, and arbitrary custom tools.
- [x] Enforce the restriction before approval policy shortcuts, approval reviewers, permission-prompt tools, and ordinary `tool_call` handlers.
- [x] When disabled, stop blocking tool calls.

### User visibility

- [x] Report status through `/safe status`.
- [x] Show a footer status while safe mode is enabled, when UI status rendering is available.

## How it works

- `pi.registerToolGate()` for unconditional tool-call gates that run before approval policy shortcuts.
- [Extension API contract](pre-tool-use-rewrites.md) for ordinary `tool_call` blocking.
- [TUI customization contract](tui-customization.md) for status rendering.
- Runtime design notes can be added later at `docs/wiki/systems/safe-mode.md`.

## Implementation inventory

- `packages/coding-agent/extensions/safe/src/index.ts` — first-party extension implementing `/safe` and the tool-gate allowlist.
- `packages/coding-agent/src/core/extensions/` — exposes `pi.registerToolGate()` and runner dispatch for unconditional gates.
- `packages/coding-agent/src/core/agent-session.ts` — runs tool gates before approval policy evaluation.
- `packages/coding-agent/src/main.ts` — registers the extension in the first-party extension list.

## Tests asserting this spec

- `packages/coding-agent/test/safe-extension.test.ts` — command behavior, allowlist enforcement, disabled behavior, status rendering.
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts` — runtime regressions proving safe mode blocks before auto-approve, `approvalRequired: false`, and approval reviewer allow paths.
- `packages/coding-agent/test/cli-runtime-inventory.test.ts` — first-party extension inventory includes `safe`.

## Known gaps (current cycle)

- [ ] None.

## Out of scope

- OS/process/filesystem/network sandboxing. Safe mode is only a Pi tool-call gate.
- Persistence across process restarts or session switches.
- A tool-management UI that removes disallowed tools from the model prompt while safe mode is enabled.
