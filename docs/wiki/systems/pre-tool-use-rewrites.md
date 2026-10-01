# Pre-tool-use rewrites

[Contract](../../specs/pre-tool-use-rewrites.md). This is an extension API, not a separate extension.

## Dispatch flow

The [agent loop](../../../packages/agent-core/src/agent-loop.ts) prepares and validates arguments before calling `beforeToolCall`. [AgentSession](../../../packages/coding-agent/src/core/agent-session.ts), in `_installAgentToolHooks`, passes that argument object as `event.input` through unconditional gates and approval orchestration. When ordinary hooks are reached, [ExtensionRunner.emitToolCall](../../../packages/coding-agent/src/core/extensions/runner.ts) walks extensions and their handlers in registration order. Every handler receives the same event: in-place changes reach later handlers and the eventual tool execution without another schema validation.

Returning `{ block: true, reason }` stops the handler chain and prevents execution. Otherwise the runner returns the last nonempty result. Handler exceptions propagate to tool preflight; AgentSession wraps non-`Error` throws with `Extension failed, blocking execution`. [Event types and `isToolCallEventType`](../../../packages/coding-agent/src/core/extensions/types.ts) provide built-in input narrowing and a generic custom-tool overload; the guard checks the tool name, not the input schema.

Approval reviewers have a separate rewrite channel. `applyApprovalReviewerResult` copies an allowed `updatedInput` into the existing object by deleting its old keys and assigning the new ones. Auto-approve still invokes registered reviewers for approval-required tools, so hook rewrites and denials remain effective. It does not run ordinary approval hooks in every policy path.

After execution, `afterToolCall` invokes `emitToolResult` when handlers exist. Returned `content`, `details`, and `isError` patches chain; omitted fields retain their current values. Result-handler errors are reported without aborting the chain.

## Boundaries

Rewrites do not rewrite the model's original assistant tool-call text. Extensions own correctness of mutated arguments. Ordinary `tool_call` handlers are approval-aware, not unconditional gates: policy shortcuts or an earlier reviewer decision can bypass them. Use the gate API for restrictions that must apply under auto-approve.

[Native `ls`](../../../packages/coding-agent/src/core/tools/ls.ts) independently delegates to `rtk ls` when available and renders as `ls`; it is not implemented by a rewrite handler. Its filesystem alternate path remains in source.

## Test evidence

Tests inspected, not run:

- [AgentSession integration](../../../packages/coding-agent/test/suite/agent-session-model-extension.test.ts): actual rewritten dispatch, shared input reference, no revalidation, blocking, non-`Error` throws, auto-approved Bash reviewer rewrite, and model-visible result patches.
- [Runner tests](../../../packages/coding-agent/test/extensions-runner.test.ts): registration, last non-blocking result, and result chaining.
- [Tool rendering](../../../packages/coding-agent/test/tool-execution-component.test.ts) and [tool behavior](../../../packages/coding-agent/test/tools.test.ts): native `ls` surfaces.
