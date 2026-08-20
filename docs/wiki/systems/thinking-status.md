# Thinking status indicator

Interactive mode starts an elapsed-duration ticker at each model request. It updates the default `Thinking...` working label once per second until visible assistant output begins or the request ends. During in-turn compaction, temporary compaction status may replace the working row; when compaction ends while the main session remains streaming, the working status is restored and the prompt spinner remains active.

Tool-wait messages take precedence while tools are active. Their live elapsed time updates through the footer's partial status region, not through recurring tool-card renders; completed cards retain final duration.

## Thinking-phase deadline

Main and child `AgentSession` runtimes start a 15-minute deadline at `agent_start`. Entering tool gates, approval review, or an interactive approval prompt clears it before waiting; the final active tool finishing starts a fresh deadline for the next model phase. Expiry aborts the active turn and surfaces a main- or child-specific timeout error. Observer runtimes are excluded. Approval waits and tool execution are uncapped, and the deadline applies to each model-thinking phase rather than the total request or turn.
