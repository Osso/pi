# Idle compaction

Contract: [idle-compaction spec](../../specs/idle-compaction.md). Implementation described here was introduced in `0d26886ee`.

## Scheduling and execution

`computeIdleCompactionDueAt` uses the latest assistant message's usage and request-start timestamp. Context must be at least 100,000 tokens. The deadline is `message.timestamp + 0.9 * TTL`; it is not measured from response completion.

`AgentSession._scheduleIdleCompaction` replaces its timer after `session_start` and each run. Persisted message timestamps allow resumed sessions to recover the deadline; an overdue eligible request schedules immediately. Disposal clears the timer.

`_findIdleCompactionTarget` excludes disposed sessions, observers, error responses, disabled settings, requests from a different current provider/model, and requests followed by compaction. `_runIdleCompaction` acquires the turn-start lock, rechecks the exact target, and skips streaming, compaction, or pending messages. It runs `_runAutoCompaction("idle", false)` rather than interrupting a turn or creating a separate summarizer. Streaming/tool work is not interrupted. A saved compaction makes the old request ineligible, preventing repeated compaction for that request.

`CompactionReason` includes `"idle"` in core and extension events. Interactive mode labels it “Compacting idle context before its prompt cache expires”. Configuration: [compaction settings](../../../packages/coding-agent/docs/settings.md#compaction).

## TTL evidence and assumptions

| Request | TTL used | Deadline | Evidence status |
|---|---|---|---|
| Model id starting with `claude-`, any API | 60 minutes | 54 minutes | User-stated. For `claude-bridge`, the bundled Claude Agent SDK `sdk.d.ts:9001` agrees: “Unset = automatic: 1 hour on a Claude subscription within its usage limits”. Session `01a1dc13` (`proxy`, `anthropic-messages`) hit the cache after 18.8 and 26.6 idle minutes, although Pi sent no `cache_control` TTL. Pi's direct Anthropic provider without `PI_CACHE_RETENTION=long` requests 5 minutes, so there the deadline is after expiry. |
| `openai-codex-responses` | 12 hours | 10.8 hours | User-stated minimum. ChatGPT Codex backend retention is undocumented and unverified. |
| Any other | 5 minutes | 4.5 minutes | Shortest common default: Anthropic `cache_control` without a TTL, and OpenAI in-memory retention. |

## Motivation and proof

Motivation: Claude Code's reported `idleCompaction` behavior, approximately 90% of TTL with a 200K minimum, discussed in [r/ClaudeAI post 1x1a6ym](https://www.reddit.com/r/ClaudeAI/comments/1x1a6ym/). This report motivates the policy; it does not establish Codex retention.

The committed faux-provider suite `packages/coding-agent/test/suite/idle-compaction.test.ts` asserts deadlines, latest-request timing, one saved summary with reason `"idle"`, the 5-minute default for unknown providers, and exclusions for small contexts and disabled settings. It also covers skipping while an agent-level message is queued. The real-process regression `test/suite/regressions/idle-compaction-restart.test.ts` crashes before the deadline, restarts, and asserts one idle compaction from the persisted request timestamp; below-minimum context does not compact.
