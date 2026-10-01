# External executable availability

Contract: [External executable availability](../../specs/system-tool-lookup.md).

## Resolution and registration

[`isExecutableAvailable()`](../../../packages/coding-agent/src/utils/executable.ts) resolves explicit paths relative to cwd or searches PATH for command names. A candidate must be a file and, on Unix, pass `X_OK`. Windows lookup expands extensionless commands with PATHEXT. Missing Unix PATH uses `/usr/bin:/bin`; empty PATH entries use cwd. This checks availability, not program version or operational health.

[`createToolDefinitionsForAvailableExecutables()`](../../../packages/coding-agent/src/core/tools/index.ts) removes `outline`, `symbol`, and `references` when `code-index` is unavailable. [`AgentSession._buildRuntime()`](../../../packages/coding-agent/src/core/agent-session.ts) calls that filtered factory on runtime construction/reload. Explicit injected code-index operations bypass the executable check; raw tool factories are not themselves availability-filtered.

[`main.ts`](../../../packages/coding-agent/src/main.ts) selects binary-backed first-party factories at process startup:

| Surface | Lookup and factory guard |
| --- | --- |
| `browser-cli` tool | PATH `browser-cli`; [`browser-cli/src/index.ts`](../../../packages/coding-agent/extensions/browser-cli/src/index.ts) |
| `pyrun_eval` tool | `PI_PYRUN_RUNNER_COMMAND`, then legacy `PI_PYRUN_RUNNER`, then `pyrun-jsonl`; [`runner.ts`](../../../packages/coding-agent/extensions/pyrun/src/runner.ts), [`index.ts`](../../../packages/coding-agent/extensions/pyrun/src/index.ts) |
| Hook approval reviewer | `PI_CLAUDE_BASH_HOOK`, otherwise existing `/home/osso/.cargo/bin/claude-bash-hook`; [`claude-bash-hook/src/index.ts`](../../../packages/coding-agent/extensions/claude-bash-hook/src/index.ts) |

Each factory checks again when loaded explicitly. An unavailable dependency omits only its registration. [`tools-manager.ts`](../../../packages/coding-agent/src/utils/tools-manager.ts) separately probes system `fd`/`fdfind` and `rg` with `--version`; missing tools return no path and optional package-manager guidance. None of these lookup paths downloads or installs a binary.

## Limits

Restart after installing/removing a dependency to recompute the first-party startup inventory; `/reload` alone cannot add a factory omitted at startup. Code-index runtime filtering and explicitly loaded factory guards are re-evaluated on reload. Availability does not guarantee a browser connection, valid runner protocol, or working hook. These gates do not govern separate administrative CLI commands or sandbox availability.

## Test locations

- [`code-index-tools.test.ts`](../../../packages/coding-agent/test/code-index-tools.test.ts): present/missing runtime tool inventories and prompt exposure.
- [`browser-cli-extension.test.ts`](../../../packages/coding-agent/test/browser-cli-extension.test.ts), [`pyrun-extension.test.ts`](../../../packages/coding-agent/test/pyrun-extension.test.ts), [`claude-bash-hook-extension.test.ts`](../../../packages/coding-agent/test/claude-bash-hook-extension.test.ts): factory registration guards.
- [`first-party-extension-availability.test.ts`](../../../packages/coding-agent/test/first-party-extension-availability.test.ts): real-process startup inventory.
- [`tools-manager.test.ts`](../../../packages/coding-agent/test/tools-manager.test.ts): missing system tool without fetch; [`extension-factory-cache.test.ts`](../../../packages/coding-agent/test/suite/regressions/extension-factory-cache.test.ts): factories rerun across loads/reload.

Tests were inspected, not executed.
