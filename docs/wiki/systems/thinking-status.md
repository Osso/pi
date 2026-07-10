# Thinking status indicator

Interactive mode starts an elapsed-duration ticker when an agent response begins. It updates the default `Thinking...` working label once per second and stops at response end.

Tool-wait messages take precedence while tools are active, so the thinking ticker leaves that row unchanged until the tool wait clears.
