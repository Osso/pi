# Thinking status indicator

Interactive mode starts an elapsed-duration ticker at each model request. It updates the default `Thinking...` working label once per second until visible assistant output begins or the request ends.

Tool-wait messages take precedence while tools are active, so the thinking ticker leaves that row unchanged until the tool wait clears.

## Thinking-phase deadline

Main and child `AgentSession` runtimes start a 15-minute deadline at `agent_start`. The first active tool clears it, and the final active tool finishing starts a fresh deadline for the next model phase. Expiry aborts the active turn and surfaces a main- or child-specific timeout error. Observer runtimes are excluded. Tool execution is uncapped, and the deadline applies to each thinking phase rather than the total request or turn.
