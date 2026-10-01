# Codex quota fallback

Contract: [Codex quota fallback](../../specs/codex-quota-fallback.md).

## Eligibility and order

[`agent-session.ts`](../../../packages/coding-agent/src/core/agent-session.ts) implements `_findQuotaFallbackModel` and `_prepareQuotaFallback`; the contract's unchecked implementation items are not evidence of absence.

Eligibility requires an assistant `error` with a matching exhaustion error string and exact active provider/model identity. The matcher recognizes usage-limit names/text, available balance, insufficient quota, out-of-budget, quota-exceeded, and selected billing exhaustion phrases. It is a text heuristic, not structured billing-status validation.

Candidate providers must expose the same model ID and pass `ModelRegistry.hasConfiguredAuth`. Search order:

| Active | Candidates |
| --- | --- |
| `openai-codex` | `openai-codex-gc`, then `openai-codex-team` |
| `openai-codex-gc` | `openai-codex`, then `openai-codex-team` |
| `openai-codex-team` | `openai-codex`, then `openai-codex-gc` |

## Continuation

Post-run handling tries quota fallback before ordinary transient retry and compaction. An accepted switch records the failed provider in a per-turn visited set, removes the trailing failed assistant from live agent context, changes the agent model, stores session model metadata, and emits `model_select` with source `fallback`. The post-run continuation requests another response; persisted failure history is not erased. Global default settings are not changed.

The visited set resets on a new user turn, preventing provider bouncing during exhaustion. Session subscribers can observe retry-intended `agent_end` events; extension `agent_end` delivery is deferred across retry continuation. Authentication is provider-keyed in [`auth-storage.ts`](../../../packages/coding-agent/src/core/auth-storage.ts), but distinct provider IDs do not establish independent upstream quotas.

## Limits and evidence

[`agent-session-retry.test.ts`](../../../packages/coding-agent/test/agent-session-retry.test.ts) asserts all three orders, exhaustion/reset, missing authentication, unrelated errors, recovery, and unchanged defaults. **Missing dedicated regressions:** absent candidate models, non-Codex active provider, failed-message identity mismatch, and extension `model_select` source. Corresponding source guards/event emission exist; these are proof gaps, not unimplemented fallback. Tests inspected, not run.
