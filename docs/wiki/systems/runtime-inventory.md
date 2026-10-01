# Runtime inventory

Contract: [Runtime inventory commands](../../specs/runtime-inventory.md).

## Entry points and data flow

Use `pi tools` / `pi extensions` for startup inventory, or `/tools` / `/extensions` inside the TUI. These describe loaded runtime resources, not installed packages (`pi list`).

[args.ts](../../../packages/coding-agent/src/cli/args.ts) parses the CLI words as metadata actions. [main.ts](../../../packages/coding-agent/src/main.ts) creates the runtime, resolves project trust, and awaits `session.bindExtensions({})` before printing and exiting. Consequently, tools registered during `session_start` are included. First-party factories have synthetic `<first-party:name>` paths; [resource-loader.ts](../../../packages/coding-agent/src/core/resource-loader.ts) loads these factories separately from filesystem discovery and applies `disabledExtensions` filtering.

[AgentSession.getAllTools](../../../packages/coding-agent/src/core/agent-session.ts) reads the configured tool-definition map; `getActiveToolNames()` reads the agent's active tools. [list-tools.ts](../../../packages/coding-agent/src/cli/list-tools.ts) sorts by name and prints active yes/no, source, and description, truncating descriptions to 54 characters. [list-extensions.ts](../../../packages/coding-agent/src/cli/list-extensions.ts) sorts by path and prints scope/source plus command, tool, and handler-map counts. The handler count counts event keys, not individual callbacks. Both formatters have explicit empty output.

[slash-commands.ts](../../../packages/coding-agent/src/core/slash-commands.ts) supplies completion entries. [InteractiveMode](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) clears the composer at dispatch and renders the same formatter output as chat `Text` components.

Defaults originate in [tools/index.ts](../../../packages/coding-agent/src/core/tools/index.ts), are selected by [sdk.ts](../../../packages/coding-agent/src/core/sdk.ts), and inform [system-prompt.ts](../../../packages/coding-agent/src/core/system-prompt.ts). Structural tools depend on `code-index` availability.

## Limits and evidence

“Active” is registration state, not permission to execute: [safe mode](safe-mode.md) can still block a listed active tool. Allow/exclude filters can remove definitions entirely, so inventory is not a catalog of every possible tool.

Test source inspected, not executed:

- [args.test.ts](../../../packages/coding-agent/test/args.test.ts), [tool-inventory.test.ts](../../../packages/coding-agent/test/tool-inventory.test.ts): parsing, formatting, empty states, command metadata.
- [cli-runtime-inventory.test.ts](../../../packages/coding-agent/test/cli-runtime-inventory.test.ts), [tool-inventory-session.test.ts](../../../packages/coding-agent/test/tool-inventory-session.test.ts): process startup/trust/disabled extensions and late registration.
- [system-prompt.test.ts](../../../packages/coding-agent/test/system-prompt.test.ts), [5109-exclude-tools.test.ts](../../../packages/coding-agent/test/suite/regressions/5109-exclude-tools.test.ts): defaults and filter behavior.

The spec's dedicated TUI inventory-rendering/composer-clear test remains a coverage gap; command metadata tests do not prove that interaction.
