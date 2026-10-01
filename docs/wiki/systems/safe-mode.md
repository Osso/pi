# Safe mode

Contract: [Safe mode capability restriction](../../specs/safe-mode.md).

## Operation

`/safe on` enables the tool-call restriction; `/safe off` disables it; `/safe` or `/safe status` reports current state. Completion offers `on`, `off`, and `status`. Invalid arguments report usage without changing state.

The [safe extension](../../../packages/coding-agent/extensions/safe/src/index.ts) keeps an `enabled` boolean in its factory closure, initially false. Enabling sets footer status key `safe` to `safe:on` and clears the editor. Disabling clears that status. `session_start` refreshes the display. There is no persisted setting; a newly loaded extension instance starts disabled, including reload or runtime replacement.

The extension registers an unconditional `registerToolGate` allowing exactly `web_search` and `ask_questions`. Other names return `{ block: true, reason: "Safe mode blocks tool: <name>" }`. The [extension runner](../../../packages/coding-agent/src/core/extensions/runner.ts) dispatches gates; [AgentSession](../../../packages/coding-agent/src/core/agent-session.ts), in `_installAgentToolHooks`, evaluates them before approval shortcuts, reviewers, permission prompts, and ordinary `tool_call` hooks. [main.ts](../../../packages/coding-agent/src/main.ts) includes the extension among first-party factories.

## Boundaries

This is a Pi tool-call restriction, not an OS sandbox. It does not remove blocked tool definitions from the model's inventory, constrain arbitrary extension code, or intercept user shell/command actions. An allowed name does not install or activate that tool. See [extension API](../../../packages/coding-agent/docs/extensions.md#piregistertoolgategate) for gate ordering and [TUI API](../../../packages/coding-agent/docs/tui.md) for status rendering.

## Evidence

Test source inspected, not executed:

- [safe-extension.test.ts](../../../packages/coding-agent/test/safe-extension.test.ts): command completion/status, allowlist, invalid input, and disabling.
- [agent-session-model-extension.test.ts](../../../packages/coding-agent/test/suite/agent-session-model-extension.test.ts): blocked execution under auto-approve, approval opt-out, and reviewer allow paths.
- [cli-runtime-inventory.test.ts](../../../packages/coding-agent/test/cli-runtime-inventory.test.ts): default first-party registration.

These tests establish the intended test coverage, not a current passing result. Safe-mode persistence is absent by design.
