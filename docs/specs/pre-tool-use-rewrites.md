# Pre-Tool-Use Rewrites

Pre-tool-use rewrites let an extension transparently mutate a tool call's arguments before dispatch, or deny the call outright — without the model knowing. Pi provides this natively: an extension registers `pi.on("tool_call", h)`, mutates `event.input` in place to patch arguments (e.g. expand a command alias), or returns `{ block: true, reason }` to deny execution. Typed per-tool guards (`isToolCallEventType`) narrow the event to bash/read/edit/write/grep/find/ls inputs. A companion `pi.on("tool_result", h)` can post-process tool output. The contract lives in `packages/coding-agent/src/core/extensions/types.ts` and is wired through `packages/coding-agent/src/core/agent-session.ts` (`beforeToolCall`/`afterToolCall`) into `runner.ts` (`emitToolCall`/`emitToolResult`). How it works belongs in docs/wiki/systems/pre-tool-use-rewrites.md.

## What it must do

### In-place argument rewrite

- [ ] A `tool_call` handler may mutate `event.input` in place to patch the tool's arguments before execution; later `tool_call` handlers observe the mutation (same object reference).
- [ ] Pi performs no re-validation of `event.input` after mutation — the rewritten arguments are dispatched as-is.
- [ ] Typed guards `isToolCallEventType("bash"|"read"|"edit"|"write"|"grep"|"find"|"ls", event)` narrow `event.input` to the correct per-tool input type; a generic `<TName, TInput>` overload covers custom tools.

### Blocking

- [ ] A `tool_call` handler returning `{ block: true, reason? }` denies the tool call; `emitToolCall` short-circuits and returns that result without running later handlers.
- [ ] When no handler blocks or rewrites, `emitToolCall` returns the last non-`undefined` result (or `undefined`), and execution proceeds.
- [ ] A non-`Error` throw inside a `tool_call` handler is wrapped as "Extension failed, blocking execution: ..." so a faulty handler fails closed rather than silently allowing.

### Wiring

- [x] `beforeToolCall`/`afterToolCall` only invoke the runner when handlers are actually registered for `tool_call`/`tool_result` (`hasHandlers` guard) (`extensions-runner.test.ts:882` asserts `hasHandlers("tool_call")` after registration).

### Post-execution (`tool_result`)

- [ ] A `tool_result` handler may return `{ content, details, isError }` to rewrite the tool's output before it reaches the model; `isError` defaults to the original when omitted.
- [ ] `tool_result` receives the same `toolName`/`toolCallId`/`input` as the call plus the produced `content`/`details`/`isError`.

## How it works

- See docs/wiki/systems/pre-tool-use-rewrites.md (stub).
- Existing operator/author docs: `packages/coding-agent/docs/extensions.md` — `tool_call` (~line 700).

## Implementation inventory

- `packages/coding-agent/src/core/extensions/types.ts:806-866` — `ToolCallEvent` union (`bash`/`read`/`edit`/`write`/`grep`/`find`/`ls`/custom) and the mutability doc comment: "`event.input` is mutable. Mutate it in place... No re-validation is performed after mutation."
- `packages/coding-agent/src/core/extensions/types.ts:969-980` — `isToolCallEventType` typed overloads + generic + runtime impl.
- `packages/coding-agent/src/core/extensions/types.ts:1020-1024` — `ToolCallEventResult` `{ block?, reason? }`: "Block tool execution. To modify arguments, mutate `event.input` in place instead."
- `packages/coding-agent/src/core/extensions/types.ts:1160-1161` — `on("tool_call", ...)` / `on("tool_result", ...)` registration.
- `packages/coding-agent/src/core/extensions/runner.ts:862-883` — `emitToolCall`: iterates handlers in registration order, short-circuits on `{ block: true }`, otherwise returns last result.
- `packages/coding-agent/src/core/extensions/runner.ts:812` — `emitToolResult`: dispatches `tool_result` handlers.
- `packages/coding-agent/src/core/agent-session.ts:414-462` — `_installAgentToolHooks`: sets `agent.beforeToolCall` (calls `emitToolCall`, wraps non-Error throws as block) and `agent.afterToolCall` (calls `emitToolResult`, maps to `{ content, details, isError }`), both gated by `hasHandlers`.

## Tests asserting this spec

- `packages/coding-agent/test/extensions-runner.test.ts:882` — `tool_call` handler registration makes `hasHandlers("tool_call")` true (registration/wiring only).

## Known gaps (current cycle)

- No dedicated test asserts an in-place `event.input` mutation actually changes the dispatched arguments.
- No dedicated test asserts `{ block: true }` short-circuits later handlers and denies execution.
- No dedicated test asserts `tool_result` output rewriting or the non-Error throw → block wrapping.

## Out of scope

- The model-facing permission/approval flow (Pi blocking is unconditional, not a "continue but ask" decision) — see docs/specs/approval-system.md.
- System-prompt / message-list injection — see docs/specs/prompt-context-hooks.md.
- Defining new custom tools (this spec covers intercepting calls, not registering tools).
