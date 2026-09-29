# Codex quota fallback

Module boundary: core subsystem (`packages/coding-agent/src/core/agent-session.ts`).

When an `AgentSession` using `openai-codex`, `openai-codex-gc`, or `openai-codex-team` receives a
terminal quota, usage-limit, or billing-exhaustion error, it can continue the same model through
another independently authenticated Codex provider. The failed assistant message must belong to
the active provider/model. This is a session-level recovery path, not generic provider retry
behavior; it changes the active session model without rewriting global defaults.

## What it must do

### Eligibility

- [ ] Detect terminal quota, usage-limit, and billing-exhaustion errors only.
- [ ] Require the failed assistant message's provider and model to match the active session model.
- [ ] Consider only configured Codex providers that expose the same model ID, in this order:
      `openai-codex` → `openai-codex-gc` → `openai-codex-team`;
      `openai-codex-gc` → `openai-codex` → `openai-codex-team`;
      `openai-codex-team` → `openai-codex` → `openai-codex-gc`.
- [ ] Store OAuth credentials separately for all three provider IDs. The same email may authenticate
      more than one provider; upstream OAuth, not Pi configuration, determines the account or
      workspace. Provider IDs alone do not prove separate quotas.
- [ ] Leave non-Codex errors unchanged and skip missing-model or unauthenticated candidates.

### Continuation

- [ ] Remove the failed assistant response from live agent context, keep the model ID, and continue
      the interrupted request through the next eligible provider.
- [ ] Count the failed active provider and every fallback provider as one attempt each; attempt each
      provider at most once per user turn and reset that guard when the next user message starts a
      new turn.
- [ ] Keep automatic fallback session-local; do not rewrite configured default provider/model
      settings or add global fallback defaults.

### Events

- [ ] Emit `model_select` with `source: "fallback"` for every automatic provider selection.
- [ ] Continue the interrupted request while fallback is pending and emit the final response without
      exposing retry state through the extension `agent_end` event.

## How it works

- [Provider authentication and Codex account setup](../../packages/coding-agent/docs/providers.md#openai-codex)
- [Retry settings](../../packages/coding-agent/docs/settings.md#retry)

## Implementation inventory

- `packages/coding-agent/src/core/agent-session.ts` — detects eligible exhaustion errors, switches
  the model, keeps fallback session-local, and drives fallback continuation state.
- `packages/coding-agent/src/core/extensions/types.ts` — defines the `model_select` fallback source.

## Tests asserting this spec

- `packages/coding-agent/test/agent-session-retry.test.ts`
  - All three fallback orders, each-provider-once exhaustion, next-turn reset, and missing-auth
    skip behavior.

## Known gaps (current cycle)

- [ ] Add regression coverage for missing models, non-Codex active providers, and failed message
      provider/model mismatches.
- [ ] Add regression coverage that `model_select` reports `source: "fallback"`.

## Out of scope

- Generic transient-error retry configuration.
- Provider-level SDK retries.
- Fallback between non-Codex providers or across different model IDs.
- Persisting an automatic fallback in global default provider/model settings; explicit model changes
  retain their existing settings behavior.
