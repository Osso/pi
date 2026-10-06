# Thinking status indicator

Module boundary: core subsystem. The interactive-mode default working indicator at `packages/coding-agent/src/modes/interactive/interactive-mode.ts` reports elapsed duration while Pi is thinking. Implementation detail belongs in `docs/wiki/systems/thinking-status.md`.

## What it must do

### Default thinking status

- [x] At agent-run and provider-request start, show `Thinking...`; post-tool continuation remains `Thinking...` throughout silent model inference (`packages/coding-agent/test/interactive-mode-idle-notification.test.ts`).
- [x] While a provider request is active, show elapsed duration beginning as `Thinking... 0s` and formatting longer durations such as `Thinking... 1m 05s` (`packages/coding-agent/test/interactive-mode-thinking-timer.test.ts`).
- [x] Switch to `Streaming...` only after the first non-empty visible assistant text delta or visible thinking delta. Empty stream events and hidden thinking do not switch the label, and provider-request end does not imply visible output (`packages/coding-agent/test/interactive-mode-idle-notification.test.ts`).
- [x] During in-turn compaction, temporary compaction status may replace the working row; when compaction ends while the main session remains streaming, restore `Thinking...` while the prompt spinner remains active (`packages/coding-agent/test/interactive-mode-compaction.test.ts`).

### Thinking-phase deadline

- [ ] Main sessions and spawned or attached child sessions abort any single model-thinking phase that reaches the default 20-minute cap; observer runtimes are excluded, tool gate/review and interactive approval waits clear the deadline before waiting, tool execution remains uncapped, and each post-tool or steered model phase receives a fresh deadline. This is not a total request or turn timeout.
- [ ] The first watchdog timeout automatically continues within the same prompt or continuation dispatch promise. One allowance is shared across that operation's internal continuations; agent starts, tools, and fresh phase deadlines do not replenish it. A new explicit prompt or continuation operation may receive a new allowance.
- [ ] A second watchdog timeout in that operation stops and reports the main- or child-specific timeout; spawned and attached child dispatches then finalize as failed rather than terminalizing on the first timeout.
- [ ] Manual cancellation never triggers watchdog continuation, including cancellation between timeout and continuation. Queued steering and follow-up input retain normal delivery and precedence without loss or duplicate dispatch.

### Tool waits

- [x] While an active tool controls the working row, the thinking-duration timer must not replace its tool-wait message (`packages/coding-agent/test/interactive-mode-thinking-timer.test.ts`).
- [x] While a pending tool runs, the footer's partial working-status region renders live elapsed time for both main-session and selected-child views (`packages/coding-agent/test/interactive-mode-tool-timing.test.ts`).
- [x] Active tool cards do not own recurring timers or trigger global transcript redraws; completed cards render final elapsed duration below compact or expanded call content (`packages/coding-agent/test/edit-tool-no-full-redraw.test.ts`, `packages/coding-agent/test/tool-execution-component.test.ts`).
- [x] When a model turn follows a completed tool and emits another tool call, render the completed interval as `Thought for <duration>` between the two tool rows; intervals shorter than one second remain hidden (`packages/coding-agent/test/interactive-mode-streaming-render-throttle.test.ts`).

### Steering

- [x] Steering submitted during model thinking aborts the active provider request and automatically continues with the steering message; agent-core owns authoritative model-request activity rather than deriving it from session events (`packages/agent-core/test/agent.test.ts`, `packages/coding-agent/test/agent-session-concurrent.test.ts`).
- [x] Steering submitted during tool execution does not abort the tool and is delivered before the next model request (`packages/coding-agent/test/suite/agent-session-queue.test.ts`).
- [x] Terminal runtime notifications for completed subagents and detached background jobs interrupt model thinking, but not tool execution (`packages/coding-agent/test/runtime-mailbox.test.ts`).

## How it works

- [Thinking status implementation](../wiki/systems/thinking-status.md).

## Implementation inventory

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — owns the default working label, thinking-duration timer, tool-wait precedence, and shared footer ownership predicate.
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` — renders final completed-tool duration below compact or expanded call content.

## Tests asserting this spec

- `packages/coding-agent/test/interactive-mode-idle-notification.test.ts` — request/run defaults, post-tool silent inference, first-visible-delta transition, and hidden-thinking behavior.
- `packages/coding-agent/test/interactive-mode-compaction.test.ts` — restores the working `Thinking...` status after in-turn compaction resumes a streaming main session.
- `packages/coding-agent/test/interactive-mode-thinking-timer.test.ts` — elapsed formatting, response-end shutdown, and tool-wait precedence.
- `packages/coding-agent/test/interactive-mode-tool-timing.test.ts` — hydrated versus unhydrated pending-tool ownership across footer paths.
- `packages/coding-agent/test/interactive-mode-streaming-render-throttle.test.ts` — completed model-turn duration placement between consecutive tools.
- `packages/coding-agent/test/edit-tool-no-full-redraw.test.ts` — real-TUI proof that offscreen active tool timing does not clear or redraw transcript scrollback.
- `packages/coding-agent/test/suite/agent-session-approval-deadline.test.ts` — pending human approval exclusion from the model-thinking deadline.
- `packages/coding-agent/test/suite/agent-session-child-activity.test.ts` — main/child per-phase deadlines, tool exclusion, continuation propagation, observer exclusion, and lifecycle cleanup.
- `packages/coding-agent/test/multi-agent-extension.test.ts` — real spawned and attached child timeout terminalization.

## Known gaps (current cycle)

- [ ] Verify the 20-minute default and one-continuation policy, including exhaustion, manual cancellation, queued input, startup continuation, and spawned/attached child dispatch ownership. Existing deadline tests do not prove the changed policy; real-process regression proof is assigned to `packages/coding-agent/test/suite/regressions/thinking-timeout-continuation.test.ts`.

## Out of scope

- Custom working messages and indicators registered by extensions; their API contract remains in `packages/coding-agent/docs/extensions.md`.
- Tool-wait wording and tool-wait elapsed-duration formatting.
