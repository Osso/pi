# Pre-Tool-Use Rewrites

Module boundary: extension API contract, not a standalone first-party extension module.

Pre-tool-use rewrites let an extension transparently mutate a tool call's arguments before dispatch, or deny the call outright — without the model knowing. Pi provides this natively: an extension registers `pi.on("tool_call", h)`, mutates `event.input` in place to patch arguments (e.g. expand a command alias), or returns `{ block: true, reason }` to deny execution. Approval reviewers can also return `updatedInput` for compatibility with existing hook systems such as `claude-bash-hook`. Typed per-tool guards (`isToolCallEventType`) narrow the event to bash/read/edit/write/grep/find/ls inputs. A companion `pi.on("tool_result", h)` can post-process tool output. The contract lives in `packages/coding-agent/src/core/extensions/types.ts` and is wired through `packages/coding-agent/src/core/agent-session.ts` (`beforeToolCall`/`afterToolCall`) into `runner.ts` (`emitToolCall`/`emitToolResult`). How it works belongs in docs/wiki/systems/pre-tool-use-rewrites.md.

## What it must do

### In-place argument rewrite

- [x] A `tool_call` handler may mutate `event.input` in place to patch the tool's arguments before execution; later `tool_call` handlers observe the mutation (same object reference).
- [x] Pi performs no re-validation of `event.input` after mutation — the rewritten arguments are dispatched as-is.
- [x] Typed guards `isToolCallEventType("bash"|"read"|"edit"|"write"|"grep"|"find"|"ls", event)` narrow `event.input` to the correct per-tool input type; a generic `<TName, TInput>` overload covers custom tools.
- [x] A registered approval reviewer may return `{ action: "allow", updatedInput }`; Pi replaces the pending tool arguments before execution, including under `auto-approve`.
- [x] The first-party `claude-bash-hook` reviewer applies `updatedInput` rewrites before Bash execution, so hook aliases such as `ls` -> `rtk ls` affect the command that actually runs.
- [x] Pi's native `ls` tool is presented and executed as `rtk ls` when `rtk` is installed, with the legacy filesystem implementation kept as the missing-`rtk` fallback.

### Blocking

- [x] A `tool_call` handler returning `{ block: true, reason? }` denies the tool call; `emitToolCall` short-circuits and returns that result without running later handlers.
- [x] When no handler blocks or rewrites, `emitToolCall` returns the last non-`undefined` result (or `undefined`), and execution proceeds.
- [x] A non-`Error` throw inside a `tool_call` handler is wrapped as "Extension failed, blocking execution: ..." so a faulty handler fails closed rather than silently allowing.

### Wiring

- [x] `beforeToolCall`/`afterToolCall` only invoke the runner when handlers are actually registered for `tool_call`/`tool_result` (`hasHandlers` guard) (`extensions-runner.test.ts:882` asserts `hasHandlers("tool_call")` after registration).
- [x] `auto-approve` still lets approval reviewers apply `updatedInput` or deny before execution; it only skips human/LLM review.

### Post-execution (`tool_result`)

- [x] A `tool_result` handler may return `{ content, details, isError }` to rewrite the tool's output before it reaches the model; `isError` defaults to the original when omitted.
- [x] `tool_result` receives the same `toolName`/`toolCallId`/`input` as the call plus the produced `content`/`details`/`isError`.

## How it works

- See docs/wiki/systems/pre-tool-use-rewrites.md (stub).
- Existing operator/author docs: `packages/coding-agent/docs/extensions.md` — `tool_call` (~line 700).

## Implementation inventory

- `packages/coding-agent/src/core/extensions/types.ts:806-866` — `ToolCallEvent` union (`bash`/`read`/`edit`/`write`/`grep`/`find`/`ls`/custom) and the mutability doc comment: "`event.input` is mutable. Mutate it in place... No re-validation is performed after mutation."
- `packages/coding-agent/src/core/extensions/types.ts:969-980` — `isToolCallEventType` typed overloads + generic + runtime impl.
- `packages/coding-agent/src/core/extensions/types.ts:1020-1024` — `ToolCallEventResult` `{ block?, reason? }`: "Block tool execution. To modify arguments, mutate `event.input` in place instead."
- `packages/coding-agent/src/core/extensions/types.ts:1160-1161` — `on("tool_call", ...)` / `on("tool_result", ...)` registration.
- `packages/coding-agent/src/core/extensions/runner.ts:862-883` — `emitToolCall`: iterates handlers in registration order, short-circuits on `{ block: true }`, otherwise returns last result.
- `packages/coding-agent/src/core/extensions/runner.ts:904-928` — `emitApprovalReviewers`: applies reviewer `updatedInput` with `replaceToolInput`.
- `packages/coding-agent/src/core/extensions/runner.ts:812` — `emitToolResult`: dispatches `tool_result` handlers.
- `packages/coding-agent/src/core/agent-session.ts:414-462` — `_installAgentToolHooks`: sets `agent.beforeToolCall` (calls `emitToolCall`, applies reviewer rewrites under `auto-approve`, wraps non-Error throws as block) and `agent.afterToolCall` (calls `emitToolResult`, maps to `{ content, details, isError }`), both gated by registered handlers/reviewers.
- `packages/coding-agent/src/core/tools/ls.ts` — native `ls` tool delegates to `rtk ls` when available and renders the call as `rtk ls`.

## Tests asserting this spec

- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts` —
	  end-to-end `tool_call` mutation dispatch, same-reference observation by later
	  handlers, no post-mutation re-validation, block denial, non-`Error` throw
	  wrapping, claude-bash-hook `updatedInput` dispatch under `auto-approve`,
	  and `tool_result` payload/rewrite behavior.
- `packages/coding-agent/test/extensions-runner.test.ts` — `tool_call`
	  registration/`hasHandlers`, and `emitToolCall` returning the last
	  non-blocking handler result.
- `packages/coding-agent/test/tool-execution-component.test.ts` — visible native
	  `ls` call rendering uses `rtk ls`.
- `packages/coding-agent/test/tools.test.ts` — native `ls` behavior still lists
	  dotfiles and directories.

## Known gaps (current cycle)

- [x] Add dedicated tests asserting in-place `event.input` mutation actually
  changes dispatched arguments.
- [x] Add dedicated tests asserting `{ block: true }` short-circuits later
  handlers and denies execution.
- [x] Add dedicated tests asserting `tool_result` output rewriting and
  non-`Error` throw → block wrapping.

## Out of scope

- The model-facing permission/approval flow (Pi blocking is unconditional, not a "continue but ask" decision) — see docs/specs/approval-system.md.
- System-prompt / message-list injection — see docs/specs/prompt-context-hooks.md.
- Defining new custom tools (this spec covers intercepting calls, not registering tools).
