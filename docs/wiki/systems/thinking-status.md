# Thinking status indicator

Contract: [Thinking status](../../specs/thinking-status.md).

Interactive mode starts an elapsed-duration ticker at each model request. It updates the default `Thinking...` working label once per second until visible assistant output begins or the request ends. During in-turn compaction, temporary compaction status may replace the working row; when compaction ends while the main session remains streaming, the working status is restored and the prompt spinner remains active.

The first non-empty visible text or thinking delta changes the label to `Streaming...`. Empty deltas and hidden thinking do not change it. Between a completed tool and a subsequent tool call, `Thought for <duration>` records the model interval when it lasts at least one second.

Tool-wait messages take precedence while tools are active. Their live elapsed time updates through the footer's partial status region, not through recurring tool-card renders; completed cards retain final duration.

## Thinking-phase deadline

Main and spawned or attached child `AgentSession` runtimes use a default 20-minute deadline for each model-thinking phase. Entering tool gates, approval review, or an interactive approval prompt clears it before waiting; the final active tool finishing starts a fresh deadline for the next model phase. Observer runtimes are excluded. Approval waits and tool execution are uncapped; this is not a total request or turn timeout.

The selected policy keeps the first watchdog abort and its automatic continuation inside the same prompt or continuation dispatch promise. One continuation allowance belongs to that explicit operation and is shared through internal continuations, rather than reset at each `agent_start`, tool, or fresh phase deadline. A second watchdog timeout stops and surfaces the main- or child-specific timeout error. Spawned and attached child dispatches remain owned across the first timeout; exhaustion finalizes the child as failed. A new explicit operation may receive a new allowance.

Manual cancellation never uses the watchdog allowance, including during the handoff to continuation. Queued steering and follow-up input retain normal delivery and precedence; recovery must not drop input or start a duplicate dispatch. This is core watchdog recovery, not goal-extension continuation or provider fallback. The [contract](../../specs/thinking-status.md) lists core and real-process regression coverage.

## Source and coverage

[interactive-mode.ts](../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) owns visible-delta detection, elapsed timers, and tool-wait precedence. [agent-session.ts](../../../packages/coding-agent/src/core/agent-session.ts) owns the abort deadline; [tool-execution.ts](../../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts) renders completed-tool durations.

[Thinking timer tests](../../../packages/coding-agent/test/interactive-mode-thinking-timer.test.ts), [idle/streaming tests](../../../packages/coding-agent/test/interactive-mode-idle-notification.test.ts), [tool timing tests](../../../packages/coding-agent/test/interactive-mode-tool-timing.test.ts), and [child activity tests](../../../packages/coding-agent/test/suite/agent-session-child-activity.test.ts) cover those boundaries. Test references are not a claim of a fresh run.
