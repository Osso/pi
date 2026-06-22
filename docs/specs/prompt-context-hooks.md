# Prompt-Context Hooks

Module boundary: extension API contract, not a standalone first-party extension module.

Prompt-context hooks let extensions inject or replace model-facing context at three distinct levels of the agent loop: per-turn (before the agent starts), per-LLM-call (the full message list), and per-provider-request (the raw wire payload). Unlike a fork that bolts external hook binaries onto fixed events, Pi exposes this natively through its in-process extension system: an extension calls `pi.on("before_agent_start", h)`, `pi.on("context", h)`, or `pi.on("before_provider_request", h)` and returns a value that Pi chains into the request. The contract lives in `packages/coding-agent/src/core/extensions/types.ts` (event + result types) and is dispatched from `packages/coding-agent/src/core/extensions/runner.ts` (the `emit*` chaining loops). How it works belongs in docs/wiki/systems/prompt-context-hooks.md.

First-party dependents: `/goal` needs `before_agent_start` to keep the active goal in the model context without core prompt hacks. Multi-agent extensions need the same hook layer as the extension-safe place to add supervisor/child-agent context, mailbox steering, or agent-specific prompt state to normal parent and child `AgentSession` prompts.

## What it must do

### Turn-level injection (`before_agent_start`)

- [x] First-party `/goal` can inject active-goal context through `before_agent_start` without modifying core prompt assembly.
- [ ] First-party multi-agent extensions can use prompt-context hooks to inject agent-specific supervision, mailbox, and steering context into parent or child agent prompts without editing core prompt assembly.
- [x] A `before_agent_start` handler that returns `{ systemPrompt }` replaces the assembled system prompt for the turn, and multiple handlers chain through `ctx.getSystemPrompt()` so each sees the prior handler's result (`extensions-runner.test.ts:654`, "base\nfirst\nsecond").
- [ ] A `before_agent_start` handler that returns `{ message }` injects that message into the turn; multiple injected messages are collected in registration order.
- [ ] The event exposes the raw expanded `prompt`, attached `images`, the fully assembled `systemPrompt`, and structured `systemPromptOptions` so an extension can inspect what Pi loaded without re-discovering resources.
- [ ] Pi returns a combined result to the agent loop only when at least one handler modified the system prompt or pushed a message; otherwise the original prompt is used unchanged.

### Message-list rewrite (`context`)

- [ ] A `context` handler may return `{ messages }` to replace the entire message list before each LLM call; the replacement is visible to subsequent `context` handlers (chaining).
- [ ] The message list handed to handlers is a `structuredClone` of the live messages, so in-place mutation cannot corrupt session state unless the handler explicitly returns a new list.
- [x] A throwing `context` handler is caught per-extension and reported to the error channel without aborting the turn (`extensions-runner.test.ts:539`).

### Provider-payload rewrite (`before_provider_request`)

- [ ] A `before_provider_request` handler may return any value to replace the raw provider payload before it is sent; returning `undefined` leaves the payload unchanged.
- [ ] Multiple `before_provider_request` handlers chain — each receives the prior handler's replacement payload.
- [ ] A throwing `before_provider_request` handler is caught per-extension and reported without aborting the request.

### Session-start signal

- [ ] A `session_start` event fires with a `reason` (startup/reload/new/resume/fork) that an extension can use to seed turn context (e.g. preload state on `startup` vs `resume`).

## How it works

- See docs/wiki/systems/prompt-context-hooks.md (stub).
- Existing operator/author docs: `packages/coding-agent/docs/extensions.md` — `before_agent_start` (~line 492), `context` (~line 620), `before_provider_request` (~line 627).

## Implementation inventory

- `packages/coding-agent/src/core/extensions/types.ts:657-667` — `BeforeAgentStartEvent` interface: `prompt`, `images`, `systemPrompt`, `systemPromptOptions`.
- `packages/coding-agent/src/core/extensions/types.ts:638-641` — `ContextEvent` interface (`messages: AgentMessage[]`), "Can modify messages."
- `packages/coding-agent/src/core/extensions/types.ts:643-647` — `BeforeProviderRequestEvent` interface (`payload: unknown`), "Can replace the payload."
- `packages/coding-agent/src/core/extensions/types.ts:1141` — `on("context", handler)` returning `ContextEventResult`.
- `packages/coding-agent/src/core/extensions/types.ts:1143-1146` — `on("before_provider_request", handler)`.
- `packages/coding-agent/src/core/extensions/types.ts:1147` — `on("before_agent_start", handler)` returning `BeforeAgentStartEventResult`.
- `packages/coding-agent/src/core/extensions/runner.ts:914-944` — `emitContext`: `structuredClone` then chained `{ messages }` replacement, per-extension error catch.
- `packages/coding-agent/src/core/extensions/runner.ts:946-978` — `emitBeforeProviderRequest`: chained payload replacement, `undefined` = no-op, per-extension error catch.
- `packages/coding-agent/src/core/extensions/runner.ts:980-1044` — `emitBeforeAgentStart`: `ctx.getSystemPrompt()` returns the chained value, collects `message[]`, returns combined result only if modified.
- `packages/coding-agent/extensions/goal/src/index.ts` — first-party `/goal` extension injects active-goal context with `before_agent_start`.
- `packages/coding-agent/extensions/agents-core/src/runtime.ts` — first-party multi-agent extension creates normal child `AgentSession` prompts; agent-specific prompt state belongs on this hook surface rather than in core prompt assembly.

## Tests asserting this spec

- `packages/coding-agent/test/extensions-runner.test.ts:654` — `before_agent_start` system-prompt chaining across two handlers.
- `packages/coding-agent/test/extensions-runner.test.ts:539` — `context` handler error is caught and reported (error path only; message replacement itself is untested).
- `packages/coding-agent/test/goal-extension.test.ts` — `/goal` uses `before_agent_start` to inject active-goal context.

## Known gaps (current cycle)

- No dedicated test asserts `context` `{ messages }` replacement actually reaches the LLM call (only the error path is covered).
- No dedicated test covers `before_provider_request` payload replacement/chaining (only referenced in the test harness).
- No dedicated test covers `before_agent_start` `{ message }` injection (only `{ systemPrompt }` chaining is tested).

## Out of scope

- External/process-based hook binaries (Pi hooks are in-process extensions, not subprocess events).
- Post-response handling (`after_provider_response`) — a separate read-only event.
- Tool-call rewriting — see docs/specs/pre-tool-use-rewrites.md.
