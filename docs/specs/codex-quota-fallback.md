# Codex paired-provider quota fallback

Module boundary: core subsystem (`packages/coding-agent/src/core/agent-session.ts`).

When an `AgentSession` using `openai-codex` or `openai-codex-gc` receives a terminal quota or
billing exhaustion error, it can continue the same model on the paired provider when that
provider has credentials and exposes the same model ID. The failed assistant message must belong
to the active provider/model. This is a session-level recovery path: automatic fallback changes
the active session model without rewriting global defaults, and is not generic provider retry
behavior.

## What it must do

### Eligibility

- [x] Detect a terminal quota/usage/billing exhaustion error and select the paired Codex provider
      only when the same model ID is registered there and that model has configured auth.
- [x] Leave the original error unchanged when the active provider is not a paired Codex provider,
      the paired model ID is missing, or the paired provider has no configured auth.
- [x] Do not treat unrelated provider errors as quota fallback candidates.
- [x] Require the failed assistant message's provider and model to match the active session model
      before considering fallback.

### Continuation

- [x] Remove the failed assistant response from live agent context, switch providers while keeping
      the model ID, and continue the interrupted request.
- [x] Keep automatic fallback session-local; do not rewrite the configured default provider/model.
- [x] Attempt paired-provider fallback at most once per user turn.
- [x] Never bounce between paired providers after the fallback attempt has been used in the turn.
- [x] Reset the fallback guard when the next user message starts a new turn.

### Events

- [x] Emit `model_select` with `source: "fallback"` when the paired provider is selected.
- [x] Continue the interrupted request through the paired provider while fallback is pending and
      emit the final response without exposing retry state through the extension `agent_end` event.

## How it works

- [Provider authentication and Codex account setup](../../packages/coding-agent/docs/providers.md#openai-codex)
- [Retry settings](../../packages/coding-agent/docs/settings.md#retry)

## Implementation inventory

- `packages/coding-agent/src/core/agent-session.ts` — detects eligible exhaustion errors, switches
  the model, keeps fallback session-local, and drives fallback continuation state.
- `packages/coding-agent/src/core/extensions/types.ts` — defines the `model_select` fallback source.

## Tests asserting this spec

- `packages/coding-agent/test/agent-session-retry.test.ts`
  - `falls back to the paired Codex provider after quota exhaustion` — paired provider, model ID,
    session-local defaults, and fallback continuation behavior.
  - `does not fall back for unrelated billing errors` — narrowed eligibility matcher.
  - `does not bounce between Codex providers and resets fallback on the next user turn` — one
    fallback per turn, reverse pairing, and next-turn guard reset.

## Known gaps (current cycle)

- [ ] Add regression coverage for missing paired auth/model, a non-paired active provider, and
      failed message provider/model mismatches.
- [ ] Add regression coverage that `model_select` reports `source: "fallback"`.

## Out of scope

- Generic transient-error retry configuration.
- Provider-level SDK retries.
- Fallback between non-Codex providers or across different model IDs.
- Persisting an automatic fallback in global default provider/model settings; explicit model changes
  retain their existing settings behavior.
