# Idle compaction

Idle compaction summarizes large idle sessions before their assumed provider prompt-cache lifetime expires. Introduced by `0d26886ee`; source lives in `packages/coding-agent/src/core/idle-compaction.ts` and `agent-session.ts`. See [implementation mechanics](../wiki/systems/idle-compaction.md).

## What it must do

- [x] Compact idle `claude-bridge` sessions at request start + 54 minutes and `openai-codex-responses` sessions at request start + 27 minutes, once per eligible request.
- [x] Measure the deadline from the latest assistant request, not the first request.
- [x] Require at least 200,000 context tokens; skip APIs without an assigned TTL.
- [x] Default `compaction.idle` to true; skip idle compaction when it or `compaction.enabled` is false.
- [x] Run normal compaction with reason `"idle"`, saving a summary without retrying a turn.
- [ ] Require the latest assistant request to match the current provider/model and not precede a later compaction.
- [ ] Revalidate eligibility under the turn-start lock; never interrupt streaming, tools, pending messages, or another compaction.
- [ ] Re-arm after `session_start` and each run, using persisted assistant request timestamps across restart.

Checked items have assertions in the committed suite listed below; tests were not rerun for this docs-only update.

## How it works

- [Idle scheduling, TTL evidence, and motivation](../wiki/systems/idle-compaction.md)
- [User configuration](../../packages/coding-agent/docs/compaction.md#idle-compaction)

## Implementation inventory

Paths below are relative to `packages/coding-agent/`:

- `src/core/idle-compaction.ts` — API TTLs, 90% deadline, and 200K context minimum.
- `src/core/agent-session.ts` — `_scheduleIdleCompaction`, `_findIdleCompactionTarget`, and `_runIdleCompaction`; lifecycle arming and locked normal compaction.
- `src/core/settings-manager.ts` — `compaction.idle` and its default-true getter.
- `src/core/extensions/types.ts` — shared `CompactionReason`, including `"idle"`, for extension events.
- `src/core/extensions/index.ts` and `src/index.ts` — public `CompactionReason` exports.
- `src/modes/interactive/components/status-indicator.ts` — shared reason typing for compaction status.
- `src/modes/interactive/interactive-mode.ts` — idle-specific progress label and failure reporting.

## Tests asserting this spec

- `packages/coding-agent/test/suite/idle-compaction.test.ts` — both TTL deadlines, latest-request timing, one saved compaction, idle reason/summary, context minimum, unsupported API, and disable settings.

## Known gaps (current cycle)

- [ ] Commit and pass the real-process restart regression in `packages/coding-agent/test/suite/regressions/idle-compaction-restart.test.ts`; currently in progress and uncommitted.
- [ ] Verify ChatGPT Codex backend cache retention. Its 30-minute TTL is a user-approved assumption, not a documented backend guarantee.
- [ ] Add behavioral coverage for current-model filtering and busy-session exclusion.

## Out of scope

- Other APIs, including Pi's direct Anthropic provider with its 5-minute default: intentionally excluded.
- Guaranteed completion before cache eviction: scheduling at 90% leaves time but does not guarantee retention or summary duration.
