# Spec validation command

Contract: [Spec validation](../../specs/spec-validation.md).

## Usage and execution

Invoke `/spec-validation` in an idle session. [`spec-validation/src/index.ts`](../../../packages/coding-agent/extensions/spec-validation/src/index.ts) registers the command with description `Validate each docs/specs/*.md file separately`. [`main.ts`](../../../packages/coding-agent/src/main.ts) includes its factory in the first-party extension inventory.

The handler checks `ctx.isIdle()`. When busy, it throws `/spec-validation is blocked while a task is running` without submitting a message or clearing the composer. When idle, it sends the module's fixed `SPEC_VALIDATION_PROMPT` through `pi.sendUserMessage()` and clears editor text. Arguments are ignored.

The prompt instructs the current agent to load `spec-format`, discover Markdown under the current project's `docs/specs/`, report missing/empty directories, and produce a separate PASS/FAIL result with concrete issues for each spec. It instructs the agent not to edit files without a later explicit request. The ordinary [slash dispatcher](slash-commands.md) executes the handler; native agent/tool continuation performs the work. There is no extension-owned file walker, validator, per-file agent dispatcher, or direct provider call.

## Limits

This is a workflow prompt, not deterministic validation. The extension neither verifies skill availability nor enforces report completeness or read-only tools. Actual spec discovery, evidence assessment, and compliance depend on the current agent and its available resources. A blocked command is surfaced through normal extension-command error reporting in [`agent-session.ts`](../../../packages/coding-agent/src/core/agent-session.ts), rather than escaping the dispatcher as an unhandled exception.

No separate validator implementation is claimed. The command's message-delivery behavior is implemented; semantic correctness of every generated validation report is not established by the tests below.

## Test locations

[`spec-validation-extension.test.ts`](../../../packages/coding-agent/test/spec-validation-extension.test.ts) asserts description, exact prompt, one submission, composer clearing, and busy rejection. [`suite/spec-validation-extension.test.ts`](../../../packages/coding-agent/test/suite/spec-validation-extension.test.ts) uses headless Pi and a faux provider to dispatch the first-party command, execute a read tool, and continue the same native turn. Its supplied PASS response is not evidence that the model validates real specs correctly.

API reference: [extension commands and message delivery](../../../packages/coding-agent/docs/extensions.md). Tests were inspected, not executed.
