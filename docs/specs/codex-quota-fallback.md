# Codex quota fallback

Module boundary: core subsystem (`packages/coding-agent/src/core/agent-session.ts`).

When an `AgentSession` using `openai`, `openai-secondary`, `openai-codex`,
`openai-codex-gc`, or `openai-codex-team` receives a terminal quota, usage-limit, or
billing-exhaustion error, it can continue the same model through another configured provider. The failed assistant message must belong to
the active provider/model. This is a session-level recovery path, not generic provider retry
behavior; it changes the active session model without rewriting global defaults.

## What it must do

### Eligibility

- [ ] Detect terminal quota, usage-limit, and billing-exhaustion errors only.
- [ ] Require the failed assistant message's provider and model to match the active session model.
- [ ] Consider only authenticated providers exposing the same model ID.
- [x] From `openai` or `openai-secondary`, try the other API provider, then `openai-codex`, `openai-codex-gc`,
      and `openai-codex-team`. From a Codex provider, try `openai`, then `openai-secondary`,
      then the other Codex providers in their existing order: `openai-codex` and
      `openai-codex-gc` prefer each other before `openai-codex-team`; `openai-codex-team`
      prefers `openai-codex` before `openai-codex-gc`.
- [ ] Use ordinary OpenAI API credentials for `openai` and custom `openai-secondary`. API credits
      are separate from subscription quota; do not recharge automatically or guarantee a spending ceiling.
- [ ] Store OAuth credentials separately for all three provider IDs. The same email may authenticate
      more than one provider; upstream OAuth, not Pi configuration, determines the account or
      workspace. Provider IDs alone do not prove separate quotas.
- [ ] Leave errors outside the eligible providers and exhaustion conditions unchanged; skip
      missing-model candidates.
- [x] Skip unauthenticated candidates.

### Continuation

- [ ] Remove the failed assistant response from live agent context.
- [x] Keep the model ID and continue the interrupted request through the next eligible provider.
- [x] Count the failed active provider and every fallback provider as one attempt each; attempt each
      provider at most once per user turn and reset that guard when the next user message starts a
      new turn.
- [x] Keep automatic fallback session-local; do not rewrite configured default provider/model
      settings or add global fallback defaults.

### Events

- [x] Emit `model_select` with `source: "fallback"` for every automatic provider selection.
- [ ] Continue the interrupted request while fallback is pending and emit the final response without
      exposing retry state through the extension `agent_end` event.

## How it works

- [Provider authentication and Codex account setup](../../packages/coding-agent/docs/providers.md#openai-codex)
- [Retry settings](../../packages/coding-agent/docs/settings.md#retry)

## Implementation inventory

- `packages/coding-agent/src/core/agent-session.ts` — detects eligible exhaustion errors, switches
  the model, keeps fallback session-local, and drives fallback continuation state.
- `packages/coding-agent/src/core/codex-quota-fallback.ts` —
  `getOpenAIQuotaFallbackProviders` supplies the AgentSession order. `CODEX_FALLBACK_PROVIDERS`
  remains Codex-only for the usage view and [Supervisor](supervisor-service.md); the resident
  Supervisor does not rotate API credentials.
- `packages/coding-agent/src/core/extensions/types.ts` — defines the `model_select` fallback source.

## Tests asserting this spec

- `packages/coding-agent/test/agent-session-retry.test.ts`
  - All five starting-provider orders, each-provider-once exhaustion, next-turn reset, and
    missing-auth skips for API and Codex providers.
  - Same-model handoff, unchanged default provider/model settings, and `model_select` fallback source.

## Known gaps (current cycle)

- [ ] Add regression coverage for missing-model candidates and failed-message provider/model
      mismatches.

## Out of scope

- Generic transient-error retry configuration.
- Provider-level SDK retries.
- Arbitrary credential rotation, round robin, monthly grant tracking, or fallback across different model IDs.
- Persisting an automatic fallback in global default provider/model settings; explicit model changes
  retain their existing settings behavior.
