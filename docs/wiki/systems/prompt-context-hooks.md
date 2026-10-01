# Prompt-context hooks

[Contract](../../specs/prompt-context-hooks.md). [Extension event types](../../../packages/coding-agent/src/core/extensions/types.ts) define three separate mutation boundaries.

## Data flow

1. **Turn:** [AgentSession.prompt](../../../packages/coding-agent/src/core/agent-session.ts) expands input and calls `emitBeforeAgentStart` with prompt, images, base system prompt, and structured prompt options. [ExtensionRunner](../../../packages/coding-agent/src/core/extensions/runner.ts) gives each handler the current chained system prompt through both the event and `ctx.getSystemPrompt()`. Returned messages accumulate in registration order; returned system prompts replace the current value. AgentSession adds messages as persisted custom messages and applies the final prompt for that turn. A turn without a replacement resets to the base prompt.
2. **Model call:** [SDK wiring](../../../packages/coding-agent/src/core/sdk.ts) connects the agent's `transformContext` to `emitContext`. The runner clones the live message list once with `structuredClone`, then chains returned `{ messages }` lists. [The agent loop](../../../packages/agent-core/src/agent-loop.ts) transforms context before converting it to provider-compatible messages. In-place edits affect the working clone, not persisted session messages; handlers share that clone until a replacement is returned.
3. **Provider request:** SDK `onPayload` calls `emitBeforeProviderRequest` when registered. Each handler sees the previous payload; any non-`undefined` return replaces it. For example, [Codex request serialization](../../../packages/ai/src/api/openai-codex-responses.ts) awaits `onPayload` before transport. These changes do not update `ctx.getSystemPrompt()`.

The runner reports ordinary handler errors and continues. Context cancellation is different: an aborted signal propagates rather than being swallowed. `emitBeforeAgentStart` returns no combined result when nothing was contributed.

`session_start` supplies lifecycle reason and optional previous-session path for restoring extension state. [Goal](../../../packages/coding-agent/extensions/goal/src/index.ts) uses `before_agent_start` for goal context. [Agents-core](../../../packages/coding-agent/extensions/agents-core/src/runtime.ts) constructs ordinary child AgentSessions with explicit runtime identity; that construction alone is not proof of agent-specific hook injection.

## Limits and implementation gaps

Unchecked contract items are not automatically missing code: message injection, context replacement, payload chaining, and structured prompt inputs are implemented. The broader promised multi-agent supervision/mailbox/steering injection is not established by the cited factory and remains an unproven integration requirement. Payload replacement also depends on the provider invoking `onPayload`; it is not a provider-independent wire interceptor.

## Test evidence

Tests inspected, not run: [runner tests](../../../packages/coding-agent/test/extensions-runner.test.ts) cover system-prompt chaining and context error reporting; [AgentSession integration](../../../packages/coding-agent/test/suite/agent-session-model-extension.test.ts) checks message injection and provider-visible context replacement while stored input stays unchanged. [Goal tests](../../../packages/coding-agent/test/goal-extension.test.ts) exercise goal injection. Dedicated provider-payload replacement/chaining coverage is not established by these cited tests.
