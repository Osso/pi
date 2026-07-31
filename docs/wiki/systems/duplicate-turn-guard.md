# Duplicate-turn loop guard

Pi's `AgentSession` keeps a small runtime-only duplicate-turn state. It fingerprints each completed assistant message by its serialized content and stop reason. Turns containing tool calls, errors, or aborts clear the state instead of participating in duplicate detection.

When two eligible assistant turns have the same fingerprint, the session queues one synthetic user-role steering message:

> You repeated the same response. Stop looping. Call `end_turn` with a concise reason describing the current state.

The synthetic message is marked as internal runtime steering. It is delivered to the model through the normal steering path, but is excluded from session persistence. The built-in `end_turn` control tool is always registered and active, even when no tools, no built-in tools, an explicit allowlist, or an exclusion list would otherwise remove it. Other tools remain subject to normal filtering. The guard does not enqueue another copy until its state is reset.

Detection resets when:

- assistant content or stop reason changes;
- tool execution starts; or
- non-synthetic user input starts.

This is exact duplicate detection, not semantic similarity detection. It does not inspect or deduplicate tool calls/results, and it does not alter the `end_turn` tool contract.

See [`docs/specs/duplicate-turn-guard.md`](../../specs/duplicate-turn-guard.md) for the behavior contract and tests.
