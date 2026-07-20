# Thinking status indicator

Module boundary: core subsystem. The interactive-mode default working indicator at `packages/coding-agent/src/modes/interactive/interactive-mode.ts` reports elapsed duration while Pi is thinking. Implementation detail belongs in `docs/wiki/systems/thinking-status.md`.

## What it must do

### Default thinking status

- [x] At agent-run and provider-request start, show `Thinking...`; post-tool continuation remains `Thinking...` throughout silent model inference (`packages/coding-agent/test/interactive-mode-idle-notification.test.ts`).
- [x] While a provider request is active, show elapsed duration beginning as `Thinking... 0s` and formatting longer durations such as `Thinking... 1m 05s` (`packages/coding-agent/test/interactive-mode-thinking-timer.test.ts`).
- [x] Switch to `Streaming...` only after the first non-empty visible assistant text delta or visible thinking delta. Empty stream events and hidden thinking do not switch the label, and provider-request end does not imply visible output (`packages/coding-agent/test/interactive-mode-idle-notification.test.ts`).

### Thinking-phase deadline

- [x] Main sessions and spawned or attached child sessions abort any single model-thinking phase that reaches 15 minutes; observer runtimes are excluded, tool execution remains uncapped, and each post-tool or steered model phase receives a fresh deadline. This is not a total request or turn timeout (`packages/coding-agent/test/suite/agent-session-child-activity.test.ts`, `packages/coding-agent/test/multi-agent-extension.test.ts`).

### Tool waits

- [x] While an active tool controls the working row, the thinking-duration timer must not replace its tool-wait message (`packages/coding-agent/test/interactive-mode-thinking-timer.test.ts`).
- [x] A pending tool component owns elapsed rendering only after its execution timing is hydrated; before hydration, the working row retains the footer elapsed duration. Both main-session and selected-child footer paths use this same ownership predicate (`packages/coding-agent/test/interactive-mode-tool-timing.test.ts`).
- [x] Once timing is hydrated, the pending tool component remains the sole elapsed renderer and places the timer below the compact or expanded call content (`packages/coding-agent/src/modes/interactive/components/tool-execution.ts`).
- [x] When a model turn follows a completed tool and emits another tool call, render the completed interval as `Thought for <duration>` between the two tool rows; intervals shorter than one second remain hidden (`packages/coding-agent/test/interactive-mode-streaming-render-throttle.test.ts`).

### Steering

- [x] Steering submitted during model thinking aborts the active provider request and automatically continues with the steering message; agent-core owns authoritative model-request activity rather than deriving it from session events (`packages/agent-core/test/agent.test.ts`, `packages/coding-agent/test/agent-session-concurrent.test.ts`).
- [x] Steering submitted during tool execution does not abort the tool and is delivered before the next model request (`packages/coding-agent/test/suite/agent-session-queue.test.ts`).
- [x] Terminal runtime notifications for completed subagents and detached background jobs interrupt model thinking, but not tool execution (`packages/coding-agent/test/runtime-mailbox.test.ts`).

## How it works

- [Thinking status implementation](../wiki/systems/thinking-status.md).

## Implementation inventory

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — owns the default working label, thinking-duration timer, tool-wait precedence, and shared footer ownership predicate.
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` — owns hydrated tool elapsed rendering below compact or expanded call content.

## Tests asserting this spec

- `packages/coding-agent/test/interactive-mode-idle-notification.test.ts` — request/run defaults, post-tool silent inference, first-visible-delta transition, and hidden-thinking behavior.
- `packages/coding-agent/test/interactive-mode-thinking-timer.test.ts` — elapsed formatting, response-end shutdown, and tool-wait precedence.
- `packages/coding-agent/test/interactive-mode-tool-timing.test.ts` — hydrated versus unhydrated pending-tool ownership across footer paths.
- `packages/coding-agent/test/interactive-mode-streaming-render-throttle.test.ts` — completed model-turn duration placement between consecutive tools.
- `packages/coding-agent/test/suite/agent-session-child-activity.test.ts` — main/child per-phase deadlines, tool exclusion, continuation propagation, observer exclusion, and lifecycle cleanup.
- `packages/coding-agent/test/multi-agent-extension.test.ts` — real spawned and attached child timeout terminalization.

## Known gaps (current cycle)

- None.

## Out of scope

- Custom working messages and indicators registered by extensions; their API contract remains in `packages/coding-agent/docs/extensions.md`.
- Tool-wait wording and tool-wait elapsed-duration formatting.
