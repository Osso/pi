# Compaction token threshold

`compaction.thresholdTokens` configures automatic compaction at an absolute context token count, independent of the active model's context window. Settings resolve through `packages/coding-agent/src/core/settings-manager.ts`; trigger evaluation lives in `packages/coding-agent/src/core/compaction/compaction.ts`. See the [compaction guide](../../packages/coding-agent/docs/compaction.md) for operation.

## What it must do

- [x] Accept an optional positive integer; reject invalid configured values explicitly.
- [x] With a token count configured, trigger when `contextTokens >= min(thresholdTokens, contextWindow * 0.9)`, including equality, before considering model `autoCompactionThreshold`; smaller windows compact at 90%.
- [x] With a token count configured, still trigger when `contextTokens > contextWindow - reserveTokens`, so very small windows keep summarization room.
- [x] With the token count omitted, preserve existing model-threshold and reserve-based trigger defaults.
- [x] Apply global configuration across sessions and models, subject to normal project and explicit settings overrides.
- [x] Preserve `reserveTokens` summarization output budgets and `keepRecentMessages` behavior.
- [x] During a running tool-bearing turn, check the configured threshold after current tool results are completed and committed, before the subsequent provider request; do not wait for the whole turn to end or require a ready speculative cache.
- [x] Preserve coherent tool-call/output pairs and continue the same active turn with compacted context; never interrupt an in-flight provider stream or uncommitted tool execution to enforce the threshold.

## How it works

- [Trigger rules and settings](../../packages/coding-agent/docs/compaction.md#when-it-triggers)
- [Global/project settings](../../packages/coding-agent/docs/settings.md#compaction)

## Implementation inventory

- `packages/coding-agent/src/core/settings-manager.ts` — settings loading and resolution.
- `packages/coding-agent/src/core/compaction-threshold.ts` — shared token-count validation.
- `packages/coding-agent/src/core/compaction/compaction.ts` — compaction settings and threshold evaluation.
- `packages/coding-agent/src/core/agent-session.ts` — session automatic-compaction integration.

## Tests asserting this spec

- `packages/coding-agent/test/compaction-threshold-tokens.test.ts` — token boundaries, the 90% cap and reserve trigger for small windows, precedence, validation, and settings resolution.
- `packages/coding-agent/test/suite/compaction-threshold-tokens.test.ts` — existing session threshold coverage; direct private `_checkCompaction` calls do not prove running-turn enforcement.
- `packages/coding-agent/test/suite/live-compaction-boundary.test.ts` — public `session.prompt()` regression for compaction between completed tool results and the next provider request, with coherent pairs and continued work.
- `packages/coding-agent/test/suite/live-compaction-restart.test.ts` — real-process supervisor restart with a live child; same session/assignment and one committed effect while the configured boundary executes.

## Known gaps (current cycle)

None in the token-threshold contract.

## Out of scope

- Changing the speculative 70% compaction cache boundary.
- Adding UI controls or changing manual/overflow compaction behavior.
- Percentage-of-window thresholds (replaced by this absolute count).
