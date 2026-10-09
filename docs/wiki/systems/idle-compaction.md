# Idle compaction

Contract: [idle-compaction spec](../../specs/idle-compaction.md). Implementation described here was introduced in `0d26886ee`.

## Scheduling and execution

`computeIdleCompactionDueAt` uses the latest assistant message's usage and request-start timestamp. Context must be at least 200,000 tokens. The deadline is `message.timestamp + 0.9 * API TTL`; it is not measured from response completion.

`AgentSession._scheduleIdleCompaction` replaces its timer after `session_start` and each run. Persisted message timestamps allow resumed sessions to recover the deadline; an overdue eligible request schedules immediately. Disposal clears the timer.

`_findIdleCompactionTarget` excludes disposed sessions, observers, error responses, disabled settings, requests from a different current provider/model, and requests followed by compaction. `_runIdleCompaction` acquires the turn-start lock, rechecks the exact target, and skips streaming, compaction, or pending messages. It runs `_runAutoCompaction("idle", false)` rather than interrupting a turn or creating a separate summarizer. Streaming/tool work is not interrupted. A saved compaction makes the old request ineligible, preventing repeated compaction for that request.

`CompactionReason` includes `"idle"` in core and extension events. Interactive mode labels it “Compacting idle context before its prompt cache expires”. Configuration: [compaction settings](../../../packages/coding-agent/docs/settings.md#compaction).

## TTL evidence and assumptions

| Request API | TTL used | Deadline | Evidence status |
|---|---|---|---|
| `claude-bridge` | 60 minutes | 54 minutes | Bundled Claude Agent SDK `sdk.d.ts:9001`: “Unset = automatic: 1 hour on a Claude subscription within its usage limits”. This is the subscription default, not a universal retention guarantee. |
| `openai-codex-responses` | 30 minutes | 27 minutes | User-approved assumption based on the [OpenAI prompt-caching guide](https://platform.openai.com/docs/guides/prompt-caching): GPT-5.6+ TTL `"30m"`, eligible at least 30 minutes. ChatGPT Codex backend retention is undocumented and unverified. |

Other APIs have no idle compaction. Pi's direct Anthropic provider (5-minute default) is intentionally excluded.

## Motivation and proof

Motivation: Claude Code's reported `idleCompaction` behavior, approximately 90% of TTL with a 200K minimum, discussed in [r/ClaudeAI post 1x1a6ym](https://www.reddit.com/r/ClaudeAI/comments/1x1a6ym/). This report motivates the policy; it does not establish Codex retention.

The committed faux-provider suite `packages/coding-agent/test/suite/idle-compaction.test.ts` asserts deadlines, latest-request timing, one saved summary with reason `"idle"`, and exclusions for small contexts, unsupported APIs, and disabled settings. The real-process restart regression at `test/suite/regressions/idle-compaction-restart.test.ts` remains uncommitted/in progress; see [known gaps](../../specs/idle-compaction.md#known-gaps-current-cycle). No tests ran for this documentation update.
