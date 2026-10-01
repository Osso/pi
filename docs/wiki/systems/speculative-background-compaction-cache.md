# Speculative background compaction cache

Contract: [Speculative background compaction cache](../../specs/speculative-background-compaction-cache.md).

## Generation and installation

[`AgentSession`](../../../packages/coding-agent/src/core/agent-session.ts) owns one in-memory cache with snapshot branch entries, leaf/session identity, preparation, model identity, thinking level, settings, system prompt, extension runner, abort controller, and pending/ready/failed state.

At 70% of the model context window, `_startBackgroundCompaction()` prepares compactable history through [`prepareCompaction()`](../../../packages/coding-agent/src/core/compaction/compaction.ts). It requires a model, snapshot leaf, and either enabled local compaction or a `compaction` handler. Existing speculative/manual/automatic compaction prevents another generation. Tool-use assistant completions can start generation before the active run ends; normal threshold handling takes precedence when already due.

Generation emits `background_compaction_start`, asks the `compaction` extension hook for a result, or uses local `compact()` when enabled. It stores a ready result without appending entries or replacing active context. Non-aborted errors mark failure and log one diagnostic; `finally` emits `background_compaction_end`.

A ready result installs through ordinary `_runAutoCompaction()`, including its `session_before_compact` gate. Idle installation runs under the turn-start lock; an active run consumes it at `prepareNextTurnWithContext`, after tool results and before the next request. Normal commit appends the compaction and rebuilds context, retaining messages/results added after the snapshot. Leaf advancement alone does not invalidate the cache.

## Validity and limits

Validity requires the snapshot leaf to remain an ancestor, plus matching session, provider/model/API, thinking level, settings, system prompt, and extension-runner identity. Invalid results are discarded. A pending cache is aborted and awaited before foreground threshold/overflow compaction; synchronous generation remains available when no usable result exists. With local compaction disabled, an extension still must supply the foreground result.

The cache is session-local memory, not a durable checkpoint or second active context. Restart does not restore pending/ready speculative work. Preparation can return no result for history too small to compact.

[`default-footer/src/index.ts`](../../../packages/coding-agent/extensions/default-footer/src/index.ts) maps generation events to `background-compaction: compacting context` and clears it on end/shutdown. Event interfaces live in [`extensions/types.ts`](../../../packages/coding-agent/src/core/extensions/types.ts).

## Test locations

[`suite/agent-session-compaction.test.ts`](../../../packages/coding-agent/test/suite/agent-session-compaction.test.ts) exercises the 70% trigger, single-flight/context isolation, mid-tool-cycle installation, advanced-leaf preservation, stale branches, lifecycle outcomes, and non-overlapping synchronous recovery. [`default-footer-extension.test.ts`](../../../packages/coding-agent/test/default-footer-extension.test.ts) covers status mapping.

Reference: [compaction API](../../../packages/coding-agent/docs/compaction.md). Tests were inspected, not executed.
