# External executable availability

Pi uses external command-line tools for optional model-facing tools and approval
integrations. It must never install or download those dependencies at runtime.

## What it must do

- [x] Resolve commands from the current `PATH` and explicit configured commands or paths.
- [x] Treat a command as available only when it resolves to a file and, on Unix,
      has execute permission. Honor Windows executable extensions during PATH lookup.
- [x] Omit the affected surface instead of registering a tool or reviewer that
      will fail immediately when its executable is unavailable.
- [x] Re-evaluate availability on each runtime build and extension reload; do not
      retain a process-global available/unavailable result.
- [x] Leave unrelated tools, extensions, approval flow, and child-session
      behavior unchanged when one optional dependency is missing.
- [x] Never install, download, or bootstrap an unavailable dependency at runtime.

### Covered surfaces

- `code-index` on `PATH` gates built-in `outline`, `symbol`, and `references`.
- `browser-cli` on `PATH` gates the first-party `browser-cli` tool.
- `PI_PYRUN_RUNNER_COMMAND`, legacy `PI_PYRUN_RUNNER`, or the default
  `pyrun-jsonl` command gates the first-party `pyrun_eval` tool.
- `PI_CLAUDE_BASH_HOOK`, or the default
  `/home/osso/.cargo/bin/claude-bash-hook` path, gates the first-party
  `claude-bash-hook` approval reviewer.
- `fd` and `rg` retain their existing system-only lookup and missing-tool
  guidance.

## How it works

- [Extension runtime and tool registration](../../packages/coding-agent/docs/extensions.md)

## Implementation inventory

- `packages/coding-agent/src/utils/executable.ts` — shared PATH and explicit-command executable resolution.
- `packages/coding-agent/src/core/tools/index.ts` — filters code-index tool definitions by availability.
- `packages/coding-agent/src/core/agent-session.ts` — rebuilds the filtered built-in tool registry for each runtime.
- `packages/coding-agent/extensions/browser-cli/src/index.ts` — skips `browser-cli` registration when unavailable.
- `packages/coding-agent/extensions/pyrun/src/runner.ts` — resolves the configured/default Pyrun runner command.
- `packages/coding-agent/extensions/pyrun/src/index.ts` — skips `pyrun_eval` and its handlers when the runner is unavailable.
- `packages/coding-agent/extensions/claude-bash-hook/src/index.ts` — skips approval-reviewer registration when the hook is unavailable.
- `packages/coding-agent/src/utils/tools-manager.ts` — existing `fd`/`rg` system-only lookup.

## Tests asserting this spec

- `packages/coding-agent/test/code-index-tools.test.ts` — present and missing `code-index` runtime inventories.
- `packages/coding-agent/test/browser-cli-extension.test.ts` — present and missing `browser-cli` registration.
- `packages/coding-agent/test/pyrun-extension.test.ts` — present and missing configured Pyrun runner registration.
- `packages/coding-agent/test/claude-bash-hook-extension.test.ts` — present and missing configured hook reviewer registration.
- `packages/coding-agent/test/tools-manager.test.ts` — system-only `fd`/`rg` lookup and no-download behavior.
- `packages/coding-agent/test/suite/regressions/extension-factory-cache.test.ts` — extension factories rerun during reload instead of retaining factory registration state.

## Known gaps (current cycle)

None.

## Out of scope

- Installing, downloading, or auto-updating optional executables.
- Replacing missing executables with in-process fallback implementations.
- Gating explicit CLI commands that are separate from the model-facing tool and approval surfaces listed above.
- Changing sandbox policy when `bwrap` itself is unavailable.
