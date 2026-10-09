# Compaction threshold percentage

`compaction.thresholdPercent` configures automatic compaction as a percentage of the active model's context window. Settings resolve through `packages/coding-agent/src/core/settings-manager.ts`; trigger evaluation lives in `packages/coding-agent/src/core/compaction/compaction.ts`. See the [compaction guide](../../packages/coding-agent/docs/compaction.md) for operation.

## What it must do

- [x] Accept an optional finite number greater than 0 and at most 100, including fractional values; reject invalid configured values explicitly.
- [x] With a percentage configured, trigger when `contextTokens >= contextWindow * thresholdPercent / 100`, including equality at 100%, before considering model `autoCompactionThreshold` or `reserveTokens`.
- [x] With the percentage omitted, preserve existing model-threshold and reserve-based trigger defaults.
- [x] Apply global configuration across sessions and models, subject to normal project and explicit settings overrides.
- [x] Preserve `reserveTokens` summarization output budgets and `keepRecentTokens` behavior.

## How it works

- [Trigger rules and settings](../../packages/coding-agent/docs/compaction.md#when-it-triggers)
- [Global/project settings](../../packages/coding-agent/docs/settings.md#compaction)

## Implementation inventory

- `packages/coding-agent/src/core/settings-manager.ts` — settings loading and resolution.
- `packages/coding-agent/src/core/compaction-threshold.ts` — shared percentage validation.
- `packages/coding-agent/src/core/compaction/compaction.ts` — compaction settings and threshold evaluation.
- `packages/coding-agent/src/core/agent-session.ts` — session automatic-compaction integration.

## Tests asserting this spec

- `packages/coding-agent/test/compaction-threshold-percent.test.ts` — percentage boundaries, precedence, validation, and settings resolution.
- `packages/coding-agent/test/suite/compaction-threshold-percent.test.ts` — session-level trigger behavior.

## Known gaps (current cycle)

None in the percentage-threshold contract.

## Out of scope

- Changing the speculative 70% compaction cache boundary.
- Adding UI controls or changing manual/overflow compaction behavior.
- Editing host or project settings, deploying, or restarting sessions.
