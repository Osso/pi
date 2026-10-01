# Claude-memory enrichment

Contract: [Claude-memory enrichment](../../specs/claude-memory-enrichment.md).

## Prompt and process flow

[`claude-memory-enrich/src/index.ts`](../../../packages/coding-agent/extensions/claude-memory-enrich/src/index.ts) handles `before_agent_start`. Empty prompts are skipped. The executable comes from `PI_CLAUDE_MEMORY`, otherwise an existing `/home/osso/.cargo/bin/claude-memory`; without either, no enrichment runs.

Each extension instance serializes requests through a promise FIFO. A child runs `<executable> enrich`, receiving one JSON `{ prompt }` line on stdin. Stdout/stderr are collected; successful stdout must parse as the hook output shape. Only trimmed, nonempty `hookSpecificOutput.additionalContext` becomes prompt context.

The returned system prompt appends one `<claude_memory_enrich>` section. An existing opening marker prevents another insertion. This is a system-prompt replacement for the turn, not an appended custom transcript message.

## Cleanup and failures

The 75-second timer starts when the child starts, not while queued. Timeout, caller abort, and shutdown request `SIGTERM`; a one-second grace timer escalates to `SIGKILL`. Settlement occurs on `close`, clears timers/listeners, removes the active process, and only then allows queued work to advance. Spawn errors are retained for close-time interpretation. Shutdown stops queued launches and awaits active close plus the queue.

Timeout reports `claude-memory enrich timed out after 75000ms`. Abort, nonzero exit, and malformed output are logged by the hook; the prompt proceeds without enrichment. No retry or process-group termination is implemented. The extension controls the direct child only and does not establish whether an external executable has descendants.

## Evidence

Tests inspected, not run: [extension tests](../../../packages/coding-agent/test/claude-memory-enrich-extension.test.ts) exercise FIFO, deadline escalation, close ordering, parsing and shutdown; [real child](../../../packages/coding-agent/test/claude-memory-enrich-real-child.test.ts) asserts a SIGTERM-resistant child is gone before settlement; [restart suite](../../../packages/coding-agent/test/suite/claude-memory-enrich-restart.test.ts) checks active-child cleanup across process restart. No missing mechanism identified for this contract.
