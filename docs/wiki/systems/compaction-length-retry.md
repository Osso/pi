# Compaction length retry

Contract: [Compaction length-retry](../../specs/compaction-length-retry.md).

## Recovery flow

[`openai-responses-shared.ts`](../../../packages/ai/src/api/openai-responses-shared.ts) finalizes `response.incomplete` with `max_output_tokens` through the normal response finalizer; other incomplete reasons throw. [`agent-loop.ts`](../../../packages/agent-core/src/agent-loop.ts) ends a length-stopped turn so the host can perform post-run recovery.

In [`agent-session.ts`](../../../packages/coding-agent/src/core/agent-session.ts), `_checkCompaction` rejects stale pre-compaction responses using persisted branch order, with timestamps for synthetic checks. Overflow classification precedes threshold checking. For a post-run `length` response above threshold, it sets `_lengthRecoveryAttempted` and invokes threshold compaction with `willRetry: true`.

After saving compaction and rebuilding context, `_runAutoCompaction` removes a trailing error/length assistant from live state, leaving history intact. Its return value drives the post-run continuation rather than recursively running the model inside compaction. A second consecutive length stop can compact but cannot trigger another length continuation. Non-length assistant messages and new user turns reset the guard. Pre-prompt checks never resume the old truncated turn.

[`overflow.ts`](../../../packages/ai/src/utils/overflow.ts) already classifies `length` with zero output and input plus cache-read at least 99% of the context window as overflow—despite the unchecked requirement. Envoy retry-buffer exhaustion uses the bounded overflow compact-and-retry path. [`retry.ts`](../../../packages/ai/src/utils/retry.ts) excludes deterministic max-output/content-filter failures from ordinary transient retries.

## Limits and evidence

Below-threshold length stops remain terminal. Idle manual compaction does not resume a length-stopped turn. Manual compaction of active work has separate state/continuation ownership so steering and the original aborted caller cannot start competing runs.

Tests inspected, not run: [session compaction](../../../packages/coding-agent/test/suite/agent-session-compaction.test.ts) covers actual continuation, consecutive truncation, reset and bounded overflow; [terminal events](../../../packages/ai/test/openai-responses-terminal-event.test.ts) and [Codex stream](../../../packages/ai/test/openai-codex-stream.test.ts) cover normalization; [overflow](../../../packages/ai/test/overflow.test.ts) and [retry](../../../packages/ai/test/retry.test.ts) cover classification. [Manual post-run race](../../../packages/coding-agent/test/suite/manual-compaction-postrun-race.test.ts), [manual steering](../../../packages/coding-agent/test/suite/manual-compaction-steering.test.ts), and [restart/child steering](../../../packages/coding-agent/test/suite/compaction-wait-agent-steering.test.ts) cover continuation boundaries. **Proof gap:** a feature-level regression pinning zero-output overflow versus threshold length recovery.
